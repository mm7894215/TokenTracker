export type PredictiveLimitAlert = {
  id: string;
  providerId: string;
  windowKey: string;
  resetMs: number;
  usedPercent: number;
  runsOutEta: string;
};

export function buildPredictiveLimitAlerts(
  dataById: Record<string, unknown>,
  options?: { now?: number },
): PredictiveLimitAlert[];

export function sendPredictiveLimitAlerts(dataById: object): number;
