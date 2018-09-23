'use strict';

const config = require('config');
const mailers = require('../lib/mailers');
const knex = require('../lib/knex');
const subscriptions = require('../models/subscriptions');
const contextHelpers = require('../lib/context-helpers');
const campaigns = require('../models/campaigns');
const templates = require('../models/templates');
const lists = require('../models/lists');
const fields = require('../models/fields');
const sendConfigurations = require('../models/send-configurations');
const links = require('../models/links');
const {CampaignSource} = require('../shared/campaigns');
const {SubscriptionStatus} = require('../shared/lists');
const tools = require('../lib/tools');
const request = require('request-promise');
const files = require('../models/files');
const htmlToText = require('html-to-text');
const {getPublicUrl} = require('../lib/urls');
const blacklist = require('../models/blacklist');
const libmime = require('libmime');


class CampaignSender {
    constructor() {
    }

    async init(settings) {
        this.listsById = Map(); // listId -> list
        this.listsByCid = Map(); // listCid -> list
        this.listsFieldsGrouped = Map(); // listId -> fieldsGrouped
        this.attachments = [];

        await knex.transaction(async tx => {
            if (settings.campaignCid) {
                this.campaign = await campaigns.rawGetByTx(tx, 'cid', settings.campaignCid);
            } else {
                this.campaign = await campaigns.rawGetByTx(tx, 'id', settings.campaignId);
            }

            this.sendConfiguration = await sendConfigurations.getByIdTx(tx, contextHelpers.getAdminContext(), campaign.send_configuration);

            for (const listSpec of campaign.lists) {
                const list = await lists.getByIdTx(tx, contextHelpers.getAdminContext(), listSpec.list);
                this.listsById.set(list.id) = list;
                this.listsByCid.set(list.cid) = list;
                this.listsFieldsGrouped.set(list.id) = await fields.listGroupedTx(tx, list.id);
            }

            if (campaign.source === CampaignSource.TEMPLATE) {
                this.template = templates.getByIdTx(tx, contextHelpers.getAdminContext(), this.campaign.data.sourceTemplate, false);
            }

            const attachments = await files.listTx(tx, contextHelpers.getAdminContext(), 'campaign', 'attachment', this.campaign.id);
            for (const attachment of attachments) {
                this.attachments.push({
                    filename: attachment.originalname,
                    path: files.getFilePath('campaign', 'attachment', this.campaign.id, attachment.filename)
                });
            }

        });

        this.useVerp = config.verp.enabled && sendConfiguration.verp_hostname;
        this.useVerpSenderHeader = useVerp && config.verp.disablesenderheader !== true;
    }

    async _getMessage(campaign, list, subscriptionGrouped, mergeTags, replaceDataImgs) {
        let html = '';
        let text = '';
        let renderTags = false;

        if (campaign.source === CampaignSource.URL) {
            const form = tools.getMessageLinks(campaign, list, subscriptionGrouped);
            for (const key in mergeTags) {
                form[key] = mergeTags[key];
            }

            const response = await request.post({
                uri: campaign.sourceUrl,
                form,
                resolveWithFullResponse: true
            });

            if (response.statusCode !== 200) {
                throw new Error(`Received status code ${httpResponse.statusCode} from ${campaign.sourceUrl}`);
            }

            html = response.body;
            text = '';
            renderTags = false;

        } else if (campaign.source === CampaignSource.CUSTOM || campaign.source === CampaignSource.CUSTOM_FROM_CAMPAIGN || campaign.source === CampaignSource.CUSTOM_FROM_TEMPLATE) {
            html = campaign.data.sourceCustom.html;
            text = campaign.data.sourceCustom.text;
            renderTags = true;

        } else if (campaign.source === CampaignSource.TEMPLATE) {
            const template = this.template;
            html = template.html;
            text = template.text;
            renderTags = true;
        }

        html = await links.updateLinks(campaign, list, subscriptionGrouped, mergeTags, html);

        const attachments = this.attachments.slice();
        if (replaceDataImgs) {
            // replace data: images with embedded attachments
            html = html.replace(/(<img\b[^>]* src\s*=[\s"']*)(data:[^"'>\s]+)/gi, (match, prefix, dataUri) => {
                let cid = shortid.generate() + '-attachments@' + campaign.address.split('@').pop();
                attachments.push({
                    path: dataUri,
                    cid
                });
                return prefix + 'cid:' + cid;
            });
        }

        const html = renderTags ? tools.formatMessage(campaign, list, subscriptionGrouped, mergeTags, html, false, true) : html;

        const text = (text || '').trim()
            ? (renderTags ? tools.formatMessage(campaign, list, subscriptionGrouped, mergeTags, text) : text)
            : htmlToText.fromString(html, {wordwrap: 130});

        return {
            html,
            text,
            attachments
        };
    }

    async getMessage(listCid, subscriptionCid) {
        const list = this.listsByCid.get(listCid);
        const subscriptionGrouped = await subscriptions.getByCid(contextHelpers.getAdminContext(), list.id, subscriptionCid);
        const flds = this.listsFieldsGrouped.get(list.id);
        const campaign = this.campaign;
        const mergeTags = fields.forHbsWithFieldsGrouped(flds, subscriptionGrouped);

        return await this._getMessage(campaign, list, subscriptionGrouped, mergeTags, false);
    }

    async sendMessage(listId, email) {
        if (await blacklist.isBlacklisted(email)) {
            return;
        }

        const list = this.listsById.get(list.id);
        const subscriptionGrouped = await subscriptions.getByEmail(contextHelpers.getAdminContext(), list.id, email);
        const flds = this.listsFieldsGrouped.get(listId);
        const campaign = this.campaign;
        const mergeTags = fields.forHbsWithFieldsGrouped(flds, subscriptionGrouped);

        const encryptionKeys = [];
        for (const fld of flds) {
            if (fld.type === 'gpg' && mergeTags[fld.key]) {
                encryptionKeys.push(mergeTags[fld.key].trim());
            }
        }

        const sendConfiguration = this.sendConfiguration;

        const {html, text, attachments} = await this._getMessage(campaign, list, subscriptionGrouped, mergeTags, true);

        const campaignAddress = [campaign.cid, list.cid, subscriptionGrouped.cid].join('.');

        let listUnsubscribe = null;
        if (!list.listunsubscribe_disabled) {
            listUnsubscribe = campaign.unsubscribe_url
                ? tools.formatMessage(campaign, list, subscriptionGrouped, mergeTags, campaign.unsubscribe_url)
                : getPublicUrl('/subscription/' + list.cid + '/unsubscribe/' + subscriptionGrouped.subscription.cid);
        }

        const mailer = await mailers.getOrCreateMailer(sendConfiguration.id);

        await mailer.throttleWait();

        const getOverridable = key => {
            if (sendConfiguration[key + '_overridable'] && this.campaign[key + '_override'] !== null) {
                return campaign[key + '_override'];
            } else {
                return sendConfiguration[key];
            }
        }

        const mail = {
            from: {
                name: getOverridable('from_name'),
                address: getOverridable('from_email')
            },
            replyTo: getOverridable('reply_to'),
            xMailer: sendConfiguration.x_mailer ? sendConfiguration.x_mailer : false,
            to: {
                name: tools.formatMessage(campaign, list, subscriptionGrouped, mergeTags, list.to_name, false, false),
                address: subscriptionGrouped.email
            },
            sender: this.useVerpSenderHeader ? campaignAddress + '@' + sendConfiguration.verp_hostname : false,

            envelope: this.useVerp ? {
                from: campaignAddress + '@' + sendConfiguration.verp_hostname,
                to: subscriptionGrouped.email
            } : false,

            headers: {
                'x-fbl': campaignAddress,
                // custom header for SparkPost
                'x-msys-api': JSON.stringify({
                    campaign_id: campaignAddress
                }),
                // custom header for SendGrid
                'x-smtpapi': JSON.stringify({
                    unique_args: {
                        campaign_id: campaignAddress
                    }
                }),
                // custom header for Mailgun
                'x-mailgun-variables': JSON.stringify({
                    campaign_id: campaignAddress
                }),
                'List-ID': {
                    prepared: true,
                    value: libmime.encodeWords(list.name) + ' <' + list.cid + '.' + getPublicUrl() + '>'
                }
            },
            list: {
                unsubscribe: listUnsubscribe
            },
            subject: tools.formatMessage(campaign, list, subscriptionGrouped, mergeTags, getOverridable('subject'), false, false),
            html,
            text,

            attachments,
            encryptionKeys
        };


        let status;
        let response;
        try {
            const info = await mailer.sendMassMail(mail);
            status = SubscriptionStatus.SUBSCRIBED;
            response = info.response || info.messageId;

            await knex('campaigns').where('id', campaign.id).increment('delivered');
        } catch (err) {
            status = SubscriptionStatus.BOUNCED;
            response = err.response || err.message;
            await knex('campaigns').where('id', campaign.id).increment('delivered').increment('bounced');
        }

        const responseId = response.split(/\s+/).pop();

        const now = new Date();
        await knex('campaign_messages').insert({
            campaign: this.campaign.id,
            list: listId,
            subscriptions: subscriptionGrouped.id,
            send_configuration: sendConfiguration.id,
            status,
            response,
            response_id: responseId,
            updated: now
        });
    }
}

module.exports = CampaignSender;