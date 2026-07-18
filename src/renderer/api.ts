import type { Api } from '../preload';

declare global { interface Window { api: Api } }
export const api: Api = window.api;
