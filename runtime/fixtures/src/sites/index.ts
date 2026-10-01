import type { SiteFactory } from '../core.ts';
import { ACCESS_SITES } from './access-sites.ts';
import { AGENT_SITES } from './agent-sites.ts';
import { DATA_SITES } from './data-sites.ts';
import { GUARD_SITES } from './guard-sites.ts';

export const SITE_FACTORIES: SiteFactory[] = [...DATA_SITES, ...GUARD_SITES, ...ACCESS_SITES, ...AGENT_SITES];
