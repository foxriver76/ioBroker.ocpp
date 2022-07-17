"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stateObjects = void 0;
exports.stateObjects = [
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
    },
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
        _id: 'connectorId',
        type: 'state',
        common: {
            name: 'Connector ID',
            type: 'number',
            role: 'text',
            write: false,
            read: true
        },
        native: {}
    },
    {
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
    },
    {
        _id: 'meterValues',
        type: 'channel',
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
            read: true
        },
        native: {}
    },
    {
        _id: 'chargeLimit',
        type: 'state',
        common: {
            name: 'Limit Ampere of Charger',
            type: 'number',
            role: 'value.power',
            write: true,
            read: true,
            unit: 'A',
            min: 0
        },
        native: {}
    },
    {
        _id: 'idTag',
        type: 'state',
        common: {
            name: 'Tag ID to validate transaction',
            type: 'string',
            role: 'text',
            write: true,
            read: false
        },
        native: {}
    }
];
//# sourceMappingURL=states.js.map