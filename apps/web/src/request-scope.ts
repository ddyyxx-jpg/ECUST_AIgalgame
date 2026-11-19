/**
 * 身份 + 房间的请求"版本"：切账号/切房间后，旧在途请求与 SSE 不得再写新画面。
 * renew() 作废旧版本并中止旧 AbortController；异步回调用 isCurrent() 核对后再落状态。
 */
export interface ScopeToken {
  version: number;
  signal: AbortSignal;
}

export class RequestScope {
  private version = 0;
  private controller = new AbortController();

  /** 开启新一代：中止上一代在途请求，返回新令牌 */
  renew(): ScopeToken {
    this.controller.abort();
    this.controller = new AbortController();
    this.version += 1;
    return this.current();
  }

  current(): ScopeToken {
    return { version: this.version, signal: this.controller.signal };
  }

  isCurrent(version: number): boolean {
    return version === this.version;
  }

  abort(): void {
    this.controller.abort();
  }
}