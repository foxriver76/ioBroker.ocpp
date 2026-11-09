import { expect } from 'chai';
import WebSocket from 'ws';
import { OcppError, OcppServer } from './ocpp-server';
import { OCPP_MESSAGE_TYPE } from './ocpp-types';

describe('OcppServer (OCPP 1.6-J RPC & Connection Management)', () => {
    let server: OcppServer;
    let port: number;

    beforeEach(async () => {
        // Pick an ephemeral port using random range 45000-55000
        port = 45000 + Math.floor(Math.random() * 10000);
        server = new OcppServer({
            callTimeoutMs: 2000,
        });
        await server.listen(port, '127.0.0.1');
    });

    afterEach(async () => {
        await server.close();
    });

    it('accepts OCPP 1.6 connection, handles BootNotification CALL, and sends CALLRESULT', async () => {
        server.onRequest = async (client, action, payload) => {
            expect(client.url).to.equal('/EVB-P123456');
            expect(client.protocol).to.equal('ocpp1.6');
            expect(action).to.equal('BootNotification');
            expect(payload.chargePointVendor).to.equal('EVBox');
            return {
                status: 'Accepted',
                currentTime: '2026-11-07T17:00:00.000Z',
                interval: 55,
            };
        };

        const ws = new WebSocket(`ws://127.0.0.1:${port}/EVB-P123456`, ['ocpp1.6']);

        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        const responsePromise = new Promise<unknown[]>(resolve => {
            ws.once('message', data => {
                resolve(JSON.parse(data.toString()) as unknown[]);
            });
        });

        ws.send(
            JSON.stringify([
                OCPP_MESSAGE_TYPE.CALL,
                'msg-001',
                'BootNotification',
                { chargePointVendor: 'EVBox', chargePointModel: 'Elvi' },
            ]),
        );

        const frame = await responsePromise;
        expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALLRESULT);
        expect(frame[1]).to.equal('msg-001');
        expect(frame[2]).to.deep.equal({
            status: 'Accepted',
            currentTime: '2026-11-07T17:00:00.000Z',
            interval: 55,
        });

        ws.on('error', () => {
            // ignore ECONNRESET on close
        });
        ws.close();
    });

    it('sends server-to-client commands (e.g. SetChargingProfile) and strips undefined fields (#24)', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/Charger1`, ['ocpp1.6']);

        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        ws.on('message', data => {
            const frame = JSON.parse(data.toString()) as [number, string, string, Record<string, any>];
            expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALL);
            expect(frame[2]).to.equal('SetChargingProfile');
            // Verify undefined fields are stripped so strict charge points do not fail schema validation
            expect('numberPhases' in frame[3].csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0]).to.equal(
                false,
            );

            ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALLRESULT, frame[1], { status: 'Accepted' }]));
        });

        const client = server.getClient('/Charger1');
        expect(client).to.not.be.undefined;

        const res = await client!.sendCommand('SetChargingProfile', {
            connectorId: 1,
            csChargingProfiles: {
                chargingProfileId: 1,
                stackLevel: 0,
                chargingProfilePurpose: 'TxDefaultProfile',
                chargingProfileKind: 'Recurring',
                recurrencyKind: 'Daily',
                chargingSchedule: {
                    duration: 86400,
                    startSchedule: '2013-01-01T00:00:00.000Z',
                    chargingRateUnit: 'A',
                    chargingSchedulePeriod: [
                        {
                            startPeriod: 0,
                            limit: 16,
                            numberPhases: undefined,
                        },
                    ],
                },
            },
        });

        expect(res).to.deep.equal({ status: 'Accepted' });
        ws.on('error', () => {
            // ignore ECONNRESET on close
        });
        ws.close();
    });

    it('sends ClearChargingProfile command to clear charging profiles', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ChargerClear`, ['ocpp1.6']);
        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', reject);
        });

        ws.on('message', data => {
            const frame = JSON.parse(data.toString()) as [number, string, string, Record<string, unknown>];
            expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALL);
            expect(frame[2]).to.equal('ClearChargingProfile');
            expect(frame[3]).to.deep.equal({ connectorId: 1 });

            ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALLRESULT, frame[1], { status: 'Accepted' }]));
        });

        const client = server.getClient('/ChargerClear');
        expect(client).to.not.be.undefined;

        const res = await client!.sendCommand('ClearChargingProfile', { connectorId: 1 });
        expect(res).to.deep.equal({ status: 'Accepted' });

        ws.on('error', () => {
            // ignore ECONNRESET on close
        });
        ws.close();
    });

    it('replaces zombie connections when the same Charge Point reconnects (#20)', async () => {
        const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ABL-101`, ['ocpp1.6']);
        await new Promise<void>(resolve => ws1.once('open', () => resolve()));

        const firstClient = server.getClient('/ABL-101');
        expect(firstClient).to.not.be.undefined;

        // Reconnect with same URL before first socket is closed
        const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ABL-101`, ['ocpp1.6']);
        await new Promise<void>(resolve => ws2.once('open', () => resolve()));

        const secondClient = server.getClient('/ABL-101');
        expect(secondClient).to.not.be.undefined;
        expect(secondClient).to.not.equal(firstClient);
        expect(server.getClients().length).to.equal(1);

        // Ensure commands go to the second (active) connection
        ws2.once('message', data => {
            const frame = JSON.parse(data.toString()) as [number, string, string, Record<string, unknown>];
            ws2.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALLRESULT, frame[1], { status: 'Accepted' }]));
        });

        const res = await secondClient!.sendCommand('RemoteStartTransaction', { connectorId: 1, idTag: 'ioBroker' });
        expect(res).to.deep.equal({ status: 'Accepted' });

        ws1.on('error', () => {
            // ignore
        });
        ws2.on('error', () => {
            // ignore
        });
        ws1.close();
        ws2.close();
    });

    it('enforces Basic Authentication when configured', async () => {
        await server.close();
        server = new OcppServer({
            validateConnection: async (_url, creds) => {
                const valid = creds?.name === 'admin' && creds?.pass === 'secret';
                return [valid, valid ? 200 : 401, valid ? 'OK' : 'Unauthorized'];
            },
        });
        await server.listen(port, '127.0.0.1');

        // 1. Invalid credentials -> rejected
        const badWs = new WebSocket(`ws://wrong:pass@127.0.0.1:${port}/EVB`, ['ocpp1.6']);
        let failed = false;
        try {
            await new Promise<void>((resolve, reject) => {
                badWs.once('open', () => resolve());
                badWs.once('error', err => reject(err));
            });
        } catch {
            failed = true;
        }
        expect(failed).to.equal(true);

        // 2. Valid credentials -> accepted
        const goodWs = new WebSocket(`ws://admin:secret@127.0.0.1:${port}/EVB`, ['ocpp1.6']);
        await new Promise<void>((resolve, reject) => {
            goodWs.once('open', () => resolve());
            goodWs.once('error', err => reject(err));
        });
        expect(server.getClient('/EVB')).to.not.be.undefined;
        goodWs.on('error', () => {
            // ignore
        });
        goodWs.close();
    });

    it('returns OCPP CALLERROR frame when handler throws OcppError', async () => {
        server.onRequest = async (_client, action) => {
            throw new OcppError('NotImplemented', `Action ${action} not supported`);
        };

        const ws = new WebSocket(`ws://127.0.0.1:${port}/EVB`, ['ocpp1.6']);
        await new Promise<void>(resolve => ws.once('open', () => resolve()));

        const errorFramePromise = new Promise<unknown[]>(resolve => {
            ws.once('message', data => resolve(JSON.parse(data.toString()) as unknown[]));
        });

        ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALL, 'err-1', 'UnknownAction', {}]));

        const frame = await errorFramePromise;
        expect(frame[0]).to.equal(OCPP_MESSAGE_TYPE.CALLERROR);
        expect(frame[1]).to.equal('err-1');
        expect(frame[2]).to.equal('NotImplemented');
        ws.on('error', () => {
            // ignore ECONNRESET on close
        });
        ws.close();
    });

    it('serializes concurrent sendCommand calls so only 1 CALL is in-flight at a time (OCPP-J section 4.1)', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/QueueBox`, ['ocpp1.6']);
        await new Promise<void>(resolve => ws.once('open', () => resolve()));

        const receivedOrder: string[] = [];
        let inFlight = 0;
        let maxInFlight = 0;

        ws.on('message', data => {
            const frame = JSON.parse(data.toString()) as [number, string, string, Record<string, unknown>];
            inFlight++;
            if (inFlight > maxInFlight) {
                maxInFlight = inFlight;
            }
            receivedOrder.push(frame[2]);

            setTimeout(() => {
                inFlight--;
                ws.send(JSON.stringify([OCPP_MESSAGE_TYPE.CALLRESULT, frame[1], { status: 'Accepted' }]));
            }, 25);
        });

        const client = server.getClient('/QueueBox')!;
        const [r1, r2, r3] = await Promise.all([
            client.sendCommand('SetChargingProfile', { connectorId: 1 }),
            client.sendCommand('ChangeAvailability', { connectorId: 1, type: 'Operative' }),
            client.sendCommand('Reset', { type: 'Soft' }),
        ]);

        expect(maxInFlight).to.equal(1);
        expect(receivedOrder).to.deep.equal(['SetChargingProfile', 'ChangeAvailability', 'Reset']);
        expect(r1).to.deep.equal({ status: 'Accepted' });
        expect(r2).to.deep.equal({ status: 'Accepted' });
        expect(r3).to.deep.equal({ status: 'Accepted' });

        ws.on('error', () => {
            // ignore
        });
        ws.close();
    });
});
