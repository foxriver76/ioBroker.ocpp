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
            read: true
        },
        native: {}
    },
    {
        _id: 'connectorId',
        type: 'state',
        common: {
            name: 'Connector ID',
            type: 'string',
            role: 'text',
            write: false,
            read: true
        },
        native: {}
    },
    {
        _id: 'enabled',
        type: 'state',
        common: {
            name: 'Charger enabled',
            type: 'boolean',
            role: 'switch.power',
            write: true,
            read: true
        },
        native: {}
    },
];
//# sourceMappingURL=states.js.map