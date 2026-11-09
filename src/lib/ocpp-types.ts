/**
 * OCPP 1.6-J (and multi-protocol foundation) types and interfaces
 */

export type OcppProtocolVersion = 'ocpp1.6' | 'ocpp2.0.1';

/** OCPP-J message type IDs according to OCPP-J specification */
export const OCPP_MESSAGE_TYPE = {
    CALL: 2,
    CALLRESULT: 3,
    CALLERROR: 4,
} as const;

export type OcppErrorCode =
    | 'NotImplemented'
    | 'NotSupported'
    | 'InternalError'
    | 'ProtocolError'
    | 'SecurityError'
    | 'FormationViolation'
    | 'PropertyConstraintViolation'
    | 'OccurenceConstraintViolation'
    | 'TypeConstraintViolation'
    | 'GenericError';

export type OcppCallFrame = [typeof OCPP_MESSAGE_TYPE.CALL, string, string, Record<string, unknown>];
export type OcppCallResultFrame = [typeof OCPP_MESSAGE_TYPE.CALLRESULT, string, Record<string, unknown>];
export type OcppCallErrorFrame = [
    typeof OCPP_MESSAGE_TYPE.CALLERROR,
    string,
    OcppErrorCode,
    string,
    Record<string, unknown>,
];

export type OcppFrame = OcppCallFrame | OcppCallResultFrame | OcppCallErrorFrame;

// ============================================================================
// Charge Point -> Central System Requests & Responses (OCPP 1.6)
// ============================================================================

export type RegistrationStatus = 'Accepted' | 'Pending' | 'Rejected';
export interface BootNotificationRequest {
    chargePointVendor: string;
    chargePointModel: string;
    chargePointSerialNumber?: string;
    chargeBoxSerialNumber?: string;
    firmwareVersion?: string;
    iccid?: string;
    imsi?: string;
    meterType?: string;
    meterSerialNumber?: string;
}
export interface BootNotificationResponse {
    status: RegistrationStatus;
    currentTime: string;
    interval: number;
}

export type AuthorizationStatus = 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';
export interface IdTagInfo {
    expiryDate?: string;
    parentIdTag?: string;
    status: AuthorizationStatus;
}
export interface AuthorizeRequest {
    idTag: string;
}
export interface AuthorizeResponse {
    idTagInfo: IdTagInfo;
}
export interface StartTransactionRequest {
    connectorId: number;
    idTag: string;
    meterStart: number;
    reservationId?: number;
    timestamp: string;
}
export interface StartTransactionResponse {
    idTagInfo: IdTagInfo;
    transactionId: number;
}

export type StopTransactionReason =
    | 'EmergencyStop'
    | 'EVDisconnected'
    | 'HardReset'
    | 'Local'
    | 'Other'
    | 'PowerLoss'
    | 'Reboot'
    | 'Remote'
    | 'SoftReset'
    | 'UnlockCommand'
    | 'DeAuthorized';
export interface SampledValue {
    value: string;
    context?:
        | 'Interruption.Begin'
        | 'Interruption.End'
        | 'Sample.Clock'
        | 'Sample.Periodic'
        | 'Transaction.Begin'
        | 'Transaction.End'
        | 'Trigger'
        | 'Other';
    format?: 'Raw' | 'SignedData';
    measurand?: string;
    phase?: 'L1' | 'L2' | 'L3' | 'N' | 'L1-N' | 'L2-N' | 'L3-N' | 'L1-L2' | 'L2-L3' | 'L3-L1';
    location?: 'Cable' | 'EV' | 'Inlet' | 'Outlet' | 'Body';
    unit?: string;
}
export interface MeterValue {
    timestamp: string;
    sampledValue: SampledValue[];
}
export interface StopTransactionRequest {
    idTag?: string;
    meterStop: number;
    timestamp: string;
    transactionId: number;
    reason?: StopTransactionReason;
    transactionData?: MeterValue[];
}
export interface StopTransactionResponse {
    idTagInfo?: IdTagInfo;
}

export type HeartbeatRequest = Record<string, never>;
export interface HeartbeatResponse {
    currentTime: string;
}

export type ChargePointStatus =
    | 'Available'
    | 'Preparing'
    | 'Charging'
    | 'SuspendedEVSE'
    | 'SuspendedEV'
    | 'Finishing'
    | 'Reserved'
    | 'Unavailable'
    | 'Faulted';

export type ChargePointErrorCode =
    | 'ConnectorLockFailure'
    | 'EVCommunicationError'
    | 'GroundFailure'
    | 'HighTemperature'
    | 'InternalError'
    | 'LocalListConflict'
    | 'NoError'
    | 'OtherError'
    | 'OverCurrentFailure'
    | 'PowerMeterFailure'
    | 'PowerSwitchFailure'
    | 'ReaderFailure'
    | 'ResetFailure'
    | 'UnderVoltage'
    | 'OverVoltage'
    | 'WeakSignal';
export interface StatusNotificationRequest {
    connectorId: number;
    errorCode: ChargePointErrorCode;
    info?: string;
    status: ChargePointStatus;
    timestamp?: string;
    vendorId?: string;
    vendorErrorCode?: string;
}

export type StatusNotificationResponse = Record<string, never>;
export interface MeterValuesRequest {
    connectorId: number;
    transactionId?: number;
    meterValue: MeterValue[];
}

export type MeterValuesResponse = Record<string, never>;

export type DataTransferStatus = 'Accepted' | 'Rejected' | 'UnknownMessageId' | 'UnknownVendorId';
export interface DataTransferRequest {
    vendorId: string;
    messageId?: string;
    data?: string;
}
export interface DataTransferResponse {
    status: DataTransferStatus;
    data?: string;
}

export type DiagnosticsStatus = 'Idle' | 'Uploaded' | 'UploadFailed' | 'Uploading';
export interface DiagnosticsStatusNotificationRequest {
    status: DiagnosticsStatus;
}

export type DiagnosticsStatusNotificationResponse = Record<string, never>;

export type FirmwareStatus =
    'Downloaded' | 'DownloadFailed' | 'Downloading' | 'Idle' | 'InstallationFailed' | 'Installing' | 'Installed';
export interface FirmwareStatusNotificationRequest {
    status: FirmwareStatus;
}

export type FirmwareStatusNotificationResponse = Record<string, never>;
export interface SecurityEventNotificationRequest {
    type: string;
    timestamp: string;
    techInfo?: string;
}

export type SecurityEventNotificationResponse = Record<string, never>;

// ============================================================================
// Central System -> Charge Point Commands & Responses (OCPP 1.6)
// ============================================================================

export type ChargingProfilePurposeType = 'ChargePointMaxProfile' | 'TxDefaultProfile' | 'TxProfile';
export type ChargingProfileKindType = 'Absolute' | 'Recurring' | 'Relative';
export type RecurrencyKindType = 'Daily' | 'Weekly';
export type ChargingRateUnitType = 'A' | 'W';
export interface ChargingSchedulePeriod {
    startPeriod: number;
    limit: number;
    numberPhases?: number;
}
export interface ChargingSchedule {
    duration?: number;
    startSchedule?: string;
    chargingRateUnit: ChargingRateUnitType;
    chargingSchedulePeriod: ChargingSchedulePeriod[];
    minChargingRate?: number;
}
export interface ChargingProfile {
    chargingProfileId: number;
    transactionId?: number;
    stackLevel: number;
    chargingProfilePurpose: ChargingProfilePurposeType;
    chargingProfileKind: ChargingProfileKindType;
    recurrencyKind?: RecurrencyKindType;
    validFrom?: string;
    validTo?: string;
    chargingSchedule: ChargingSchedule;
}
export interface RemoteStartTransactionRequest {
    connectorId?: number;
    idTag: string;
    chargingProfile?: ChargingProfile;
}

export type RemoteStartStopStatus = 'Accepted' | 'Rejected';
export interface RemoteStartTransactionResponse {
    status: RemoteStartStopStatus;
}
export interface RemoteStopTransactionRequest {
    transactionId: number;
}
export interface RemoteStopTransactionResponse {
    status: RemoteStartStopStatus;
}

export type AvailabilityType = 'Inoperative' | 'Operative';
export type AvailabilityStatus = 'Accepted' | 'Rejected' | 'Scheduled';
export interface ChangeAvailabilityRequest {
    connectorId: number;
    type: AvailabilityType;
}
export interface ChangeAvailabilityResponse {
    status: AvailabilityStatus;
}

export type ChargingProfileStatus = 'Accepted' | 'Rejected' | 'NotSupported';
export interface SetChargingProfileRequest {
    connectorId: number;
    csChargingProfiles: ChargingProfile;
}
export interface SetChargingProfileResponse {
    status: ChargingProfileStatus;
}
export interface ClearChargingProfileRequest {
    id?: number;
    connectorId?: number;
    chargingProfilePurpose?: ChargingProfilePurposeType;
    stackLevel?: number;
}

export type ClearChargingProfileStatus = 'Accepted' | 'Unknown';
export interface ClearChargingProfileResponse {
    status: ClearChargingProfileStatus;
}
export interface GetConfigurationRequest {
    key?: string[];
}
export interface KeyValue {
    key: string;
    readonly: boolean;
    value?: string;
}
export interface GetConfigurationResponse {
    configurationKey?: KeyValue[];
    unknownKey?: string[];
}

export type ConfigurationStatus = 'Accepted' | 'Rejected' | 'RebootRequired' | 'NotSupported';
export interface ChangeConfigurationRequest {
    key: string;
    value: string;
}
export interface ChangeConfigurationResponse {
    status: ConfigurationStatus;
}

export type ResetType = 'Hard' | 'Soft';
export type ResetStatus = 'Accepted' | 'Rejected';
export interface ResetRequest {
    type: ResetType;
}
export interface ResetResponse {
    status: ResetStatus;
}

export type MessageTrigger =
    | 'BootNotification'
    | 'DiagnosticsStatusNotification'
    | 'FirmwareStatusNotification'
    | 'Heartbeat'
    | 'MeterValues'
    | 'StatusNotification';

export type TriggerMessageStatus = 'Accepted' | 'Rejected' | 'NotImplemented';
export interface TriggerMessageRequest {
    requestedMessage: MessageTrigger;
    connectorId?: number;
}
export interface TriggerMessageResponse {
    status: TriggerMessageStatus;
}

export type GetLocalListVersionRequest = Record<string, never>;
export interface GetLocalListVersionResponse {
    listVersion: number;
}

export type UpdateType = 'Differential' | 'Full';
export type UpdateStatus = 'Accepted' | 'Failed' | 'NotSupported' | 'VersionMismatch';
export interface AuthorizationData {
    idTag: string;
    idTagInfo?: IdTagInfo;
}
export interface SendLocalListRequest {
    listVersion: number;
    localAuthorizationList?: AuthorizationData[];
    updateType: UpdateType;
}
export interface SendLocalListResponse {
    status: UpdateStatus;
}
