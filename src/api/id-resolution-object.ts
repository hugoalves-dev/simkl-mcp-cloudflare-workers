import { DurableObject } from 'cloudflare:workers';
import { IdResolutionStore } from './id-resolution-store';
import {
  parseIdCacheTtlSeconds, parseRedirectDailyBudget,
  type RedirectReservation, type ResolvedSimklId,
} from './id-resolution';

export interface IdResolutionEnv {
  SIMKL_REDIRECT_DAILY_BUDGET?: string;
  SIMKL_ID_CACHE_TTL_SECONDS?: string;
}

/**
 * Single application-wide object. Durable Object methods with only synchronous
 * SQL run to completion, so concurrent Workers cannot overrun the budget.
 */
export class SimklIdResolutionGuard extends DurableObject<IdResolutionEnv> {
  private readonly resolutions: IdResolutionStore;
  private readonly budget: number;
  private readonly ttlSeconds: number;

  constructor(ctx: DurableObjectState, env: IdResolutionEnv) {
    super(ctx, env);
    this.resolutions = new IdResolutionStore(ctx.storage);
    this.budget = parseRedirectDailyBudget(env?.SIMKL_REDIRECT_DAILY_BUDGET);
    this.ttlSeconds = parseIdCacheTtlSeconds(env?.SIMKL_ID_CACHE_TTL_SECONDS);
  }

  lookup(key: string): ResolvedSimklId | null {
    return this.resolutions.lookup(key, Date.now());
  }

  reserve(): RedirectReservation {
    const reservation = this.resolutions.reserve(Date.now(), this.budget);
    // Allowlisted fields only: no key, ID, title or client_id.
    if (!reservation.allowed) {
      console.warn(JSON.stringify({ component: 'simkl_redirect_guard', event: 'budget_exhausted', budget: this.budget }));
    }
    return reservation;
  }

  store(key: string, value: ResolvedSimklId): void {
    this.resolutions.store(key, value, Date.now(), this.ttlSeconds);
  }
}
