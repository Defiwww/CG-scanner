/** Decimal strings cross the API boundary without binary rounding. Times are UTC epoch milliseconds. */
export type Readiness = 'ready' | 'no_trades' | 'insufficient_history' | 'gap' | 'unavailable' | 'stale';
export interface Measurement { value: string | null; from: number; to: number; observations: number; readiness: Readiness; reason: string }
export interface AnalysisTrade { id: string; eventMs: number; knownMs: number; side: 'buy' | 'sell' | null; usd: string | null; price: string | null; sender: string | null }
export interface AnalysisObservation { at: number; knownMs: number; price: string | null; reserve: string | null; source: string }
export interface AnalysisCandle { openMs: number; knownMs: number; close: string; volume: string | null; source: string }
export interface CoverageRange { from: number; to: number; knownMs: number }
export interface AnalysisInput { trades: AnalysisTrade[]; observations: AnalysisObservation[]; candles: AnalysisCandle[]; coverage: CoverageRange[] }
export interface MetricWindow {
  minutes: number; from: number; to: number; readiness: Readiness; coveredSeconds: number;
  metrics: Record<string, Measurement>; tradeIds: string[]; sellIds: string[];
}
export interface MetricsSnapshot {
  sellers?: SellerSummary;
  algorithm: string; poolId: string; asOf: number; computedAt: number; status: Readiness;
  windows: MetricWindow[]; baseline: MetricWindow; threshold: Measurement & { fallback: boolean; frozenAt: number };
  comparisons: Record<string, Measurement>;
  chart: { at: number; price: string | null; buy: string | null; sell: string | null; covered: boolean }[];
}
export interface ScoreComponent { name: string; input: string | null; severity: string | null; contribution: string; weight: number; reason: string }
export interface RiskSnapshot { score: number | null; state: string; provisional: boolean; activeMaxWeight: number; components: ScoreComponent[]; gates: { name: string; pass: boolean; actual: string; required: string }[]; explanation: string; asOf: number }
export interface PriceEvidence { value: string; source: string; observedAt: number; eventAt: number | null }
export interface AnalysisResponse { stream?: {state: 'LIVE'|'STALE'|'DISCONNECTED';reason:string}; liveAlertsEnabled?:boolean; wallets?:SellerSummary; latestObservedPrice?: PriceEvidence | null; latestConfirmedTradePrice?: PriceEvidence | null; metrics: MetricsSnapshot | null; risk: RiskSnapshot | null; poolId: string; collectedThrough: number | null; status: string; error: string | null; signals: SignalRecord[] }
export interface SignalRecord { state:string; id: string; poolId: string; mode: 'live' | 'synthetic' | 'replay'; firedAt: number; score: number; explanation: string; outcomes: { horizon: number; dueAt: number; status: string; price: string | null; returnPct: string | null; observedAt: number | null; receivedAt: number | null; delayMs: number | null; reason: string }[] }

export interface SellerWallet { address:string; buyUsd:string; sellUsd:string; netFlow:string; trades:number; sells:number; firstSeen:number; lastSeen:number; shiftedToSelling:boolean }
export interface SellerSummary { repeatedSellCount:number; wallets:SellerWallet[]; top3Share:string|null; repeatedShare:string|null; riskShare:string|null; senderCoverage:string|null; basis:'wallet-based'|'trade-based'; reason:string }
