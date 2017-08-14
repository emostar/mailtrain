'use strict';

const knex = require('../lib/knex');
const dtHelpers = require('../lib/dt-helpers');
const interoperableErrors = require('../shared/interoperable-errors');
const shares = require('./shares');
const fields = require('./fields');
const { SubscriptionStatus } = require('../shared/lists');

const allowedKeysBase = new Set(['cid', 'email']);

function hash(entity) {
    const allowedKeys = allowedKeysBase.slice();

    // TODO add keys from custom fields

    return hasher.hash(filterObject(entity, allowedKeys));
}


async function listDTAjax(context, listId, params) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'viewSubscriptions');

        const flds = await fields.listByOrderListTx(tx, listId, ['column']);

        return await dtHelpers.ajaxListTx(
            tx,
            params,
            builder => builder.from(`subscription__${listId}`),
            ['id', 'cid', 'email', 'status', 'created', ...flds.map(fld => fld.column)]
        );
    });
}

async function list(context, listId) {
    return await knex.transaction(async tx => {
        await shares.enforceEntityPermissionTx(tx, context, 'list', listId, 'viewSubscriptions');

        return await tx(`subscription__${listId}`);
    });
}


module.exports = {
    list,
    listDTAjax
};