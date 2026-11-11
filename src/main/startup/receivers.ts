/**
 * Starts the inbound status receivers at boot. Each is optional: a failure is logged and the
 * app runs without that integration rather than failing startup.
 */
import type { Services } from '../services';

/**
 * Starts the Claude notification hook receiver. A failure does not affect the live-screen
 * status monitor or generic command notifications.
 */
export async function startReceivers(services: Pick<Services, 'hookRuntime'>): Promise<void> {
  try {
    await services.hookRuntime.start();
  } catch {
    console.warn('[metaide] Claude hook receiver unavailable; Claude hook notifications disabled');
  }
}
