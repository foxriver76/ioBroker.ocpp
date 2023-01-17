"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConnectorObjects = exports.deviceObjects = void 0;
exports.deviceObjects = [
    {
        _id: 'connected',
        type: 'state',
        common: {
            name: 'If connected to server',
            type: 'boolean',
            role: 'indicator.connected',
            write: false,
            read: true
        },
        native: {}
    }
];
/**
 * Returns the objects for a single connector, w.r.t. the connectorId
 * The main (id = 0) does not have all states
 * @param connectorId
 */
function getConnectorObjects(connectorId) {
    const objs = [
        {
            _id: 'status',
            type: 'state',
            common: {
                name: 'Current status of wallbox',
                type: 'string',
                role: 'indicator.status',
                write: false,
                read: true,
                states: [
                    'Available',
                    'Preparing',
                    'Charging',
                    'SuspendedEVSE',
                    'SuspendedEV',
                    'Finishing',
                    'Reserved',
                    'Unavailable',
                    'Faulted'
                ]
            },
            native: {}
        },
        {
            _id: 'meterValues',
            type: 'folder',
            common: {
                name: 'Meter values'
            },
            native: {}
        },
        {
            _id: 'availability',
            type: 'state',
            common: {
                name: 'Switch availability',
                type: 'boolean',
                role: 'switch.power',
                write: true,
                read: true,
                desc: 'On main, this changes availability of all connectors'
            },
            native: {}
        }
    ];
    // states only available for main
    if (connectorId === 0) {
        objs.push({
            _id: 'softReset',
            type: 'state',
            common: {
                name: 'Trigger soft reset',
                type: 'boolean',
                role: 'button',
                write: true,
                read: false
            },
            native: {}
        });
        objs.push({
            _id: 'hardReset',
            type: 'state',
            common: {
                name: 'Trigger hard reset',
                type: 'boolean',
                role: 'button',
                write: true,
                read: false
            },
            native: {}
        });
    }
    // states which are not available for main
    if (connectorId !== 0) {
        objs.push({
            _id: 'transactionActive',
            type: 'state',
            common: {
                name: 'Transaction active',
                type: 'boolean',
                role: 'switch.power',
                write: true,
                read: true
            },
            native: {}
        });
        objs.push({
            _id: 'lastTransactionConsumption',
            type: 'state',
            common: {
                name: 'Consumption by last transaction',
                type: 'number',
                role: 'value.power',
                write: true,
                read: false,
                unit: 'W'
            },
            native: {}
        });
        objs.push({
            _id: 'transactionStartMeter',
            type: 'state',
            common: {
                name: 'Meter at last transaction start',
                type: 'number',
                role: 'value.power',
                write: true,
                read: false,
                unit: 'W'
            },
            native: {}
        });
        objs.push({
            _id: 'transactionEndMeter',
            type: 'state',
            common: {
                name: 'Meter at last transaction end',
                type: 'number',
                role: 'value.power',
                write: true,
                read: false,
                unit: 'W'
            },
            native: {}
        });
        objs.push({
            _id: 'idTag',
            type: 'state',
            common: {
                name: 'ID Tag of transaction',
                type: 'string',
                role: 'text',
                write: false,
                read: true
            },
            native: {}
        });
        objs.push({
            _id: 'chargeLimit',
            type: 'state',
            common: {
                name: 'Limit Watt/Ampere of Charger',
                type: 'number',
                role: 'value.power',
                write: true,
                read: true,
                unit: 'A',
                min: 0
            },
            native: {}
        });
        objs.push({
            _id: 'chargeLimitType',
            type: 'state',
            common: {
                name: 'Type of Charge Limit',
                type: 'string',
                role: 'text',
                write: true,
                read: true,
                states: ['A', 'W'],
                def: 'A'
            },
            native: {}
        });
        objs.push({
            _id: 'numberPhases',
            type: 'state',
            common: {
                name: 'Number of phases used for charging',
                type: 'number',
                role: 'value',
                write: true,
                read: true,
                def: 3,
                min: 0,
                max: 3
            },
            native: {}
        });
    }
    return objs;
}
exports.getConnectorObjects = getConnectorObjects;
//# sourceMappingURL=states.js.map