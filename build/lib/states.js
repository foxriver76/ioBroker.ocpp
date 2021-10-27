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
    }
];
//# sourceMappingURL=states.js.map