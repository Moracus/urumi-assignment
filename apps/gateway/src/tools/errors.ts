export class UpstreamUnavailableError extends Error {
  constructor(
    public readonly upstreamName: string,
  ) {
    super(`Upstream '${upstreamName}' is unavailable`);
    this.name = "UpstreamUnavailableError";
  }
}

export class UpstreamTimeoutError extends Error {
  constructor(upstreamName: string) {
    super(`Upstream '${upstreamName}' timed out`);

    this.name = "UpstreamTimeoutError";
  }
}

export class UpstreamCallError extends Error {
  constructor(upstreamName: string) {
    super(`Tool invocation failed on '${upstreamName}'`);

    this.name = "UpstreamCallError";
  }
}