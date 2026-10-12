/**
 * Local usage estimate. Documented billing: 1 credit per successful (HTTP 200)
 * REST response; 0.1 credit per WebSocket response. Heartbeats and control
 * frames are counted separately until their billing is confirmed. This is an
 * estimate, never the official account balance.
 */

export interface UsageSnapshot {
  rest: { attempts: number; successes: number; errors: number; byRoute: Record<string, { attempts: number; successes: number; errors: number }> };
  ws: { dataMessages: number; controlMessages: number; heartbeats: number; sentMessages: number; connections: number };
  estimatedCredits: number;
  note: string;
}

export class UsageCounters {
  private readonly rest = { attempts: 0, successes: 0, errors: 0 };
  private readonly byRoute: UsageSnapshot['rest']['byRoute'] = {};
  private readonly ws = { dataMessages: 0, controlMessages: 0, heartbeats: 0, sentMessages: 0, connections: 0 };

  constructor(private readonly wsCreditsPerResponse: number) {}

  private route(id: string) {
    return (this.byRoute[id] ??= { attempts: 0, successes: 0, errors: 0 });
  }
  restAttempt(id: string) {
    this.rest.attempts++;
    this.route(id).attempts++;
  }
  restSuccess(id: string) {
    this.rest.successes++;
    this.route(id).successes++;
  }
  restError(id: string) {
    this.rest.errors++;
    this.route(id).errors++;
  }
  wsData() {
    this.ws.dataMessages++;
  }
  wsControl() {
    this.ws.controlMessages++;
  }
  wsHeartbeat() {
    this.ws.heartbeats++;
  }
  wsSent() {
    this.ws.sentMessages++;
  }
  wsConnection() {
    this.ws.connections++;
  }

  snapshot(): UsageSnapshot {
    return {
      rest: { ...this.rest, byRoute: structuredClone(this.byRoute) },
      ws: { ...this.ws },
      // Control frames are included as responses (conservative); heartbeats excluded until billing is confirmed.
      estimatedCredits: Math.round((this.rest.successes + this.wsCreditsPerResponse * (this.ws.dataMessages + this.ws.controlMessages)) * 10) / 10,
      note: 'Local estimate: 1 credit per successful REST response + 0.1 per WS data/control response; heartbeats counted separately. Not the official balance.',
    };
  }
}
