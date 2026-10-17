/**
 * Starts the inbound status receivers at boot. Each is optional: a failure is logged and the
 * app runs without that integration rather than failing startup.
 */
import type { Services } from '../services';

/**
 * Starts the Claude notification hook receiver, then the OMP status receiver, sequentially.
 * A hook-receiver failure does not affect the live-screen status monitor or generic command
 * notifications; an OMP failure leaves OMP launches runnable without status integration.
 */
export async function startReceivers(services: Pick<Services, 'hookRuntime' | 'ompReceiver'>): Promise<void> {
  try {
    await services.hookRuntime.start();
  } catch {
    console.warn('[metaide] Claude hook receiver unavailable; Claude hook notifications disabled');
  }
  try {
    await services.ompReceiver.start();
  } catch {
    console.warn('[metaide] OMP status receiver unavailable; OMP launches remain runnable without status integration');
  }
}
