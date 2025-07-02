import momentTimezone from 'moment-timezone';
import ping from 'ping';
import { PrismaClient } from '@prisma/client/storage/client.js';
import { IEventDecisionMap, INetworkTrackerHost } from './interfaces/index.js';

const GOOGLE_PING_TIMEOUT = 8;
const NETWORK_TRACKER_HOST_PING_TIMEOUT = 8;
const CONSECUTIVE_SUCCESSES_THRESHOLD = 4;
const CONSECUTIVE_FAILURES_THRESHOLD = 4;
const PING_ATTEMPTS = 4;
const PING_ATTEMPT_INTERVAL = 4_000;
const EVENT_INTERVAL = 600_000;
const SUCCESS_CODE = 'R361';
const FAILURE_CODE = 'E361';

const prisma = new PrismaClient();

const performPingWithRetries = async (
  host: string, 
  timeout: number, 
  retries: number = PING_ATTEMPTS
): Promise<boolean> => {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await ping.promise.probe(
        host, 
        {
          timeout,
          extra: ['-4']
        }
      );
      
      if (response.alive) {
        return true;
      }
    } catch (error: unknown) {
      console.log(`Error | Timestamp: ${ momentTimezone().utc().format('DD-MM-YYYY HH:mm:ss') } | Path: src/routes/createNetworkTrackerEvents.service.ts | Location: performPingWithRetries | Error: ${ error instanceof Error ? error.message : String(error) }`);
    }
    
    if (attempt < retries) {
      await new Promise<unknown>((resolve: (value: unknown) => void): NodeJS.Timeout => setTimeout(resolve, PING_ATTEMPT_INTERVAL));
    }
  }
  
  return false;
};

const shouldCreateEvent = async (networkTrackerHost: INetworkTrackerHost.INetworkTrackerHost): Promise<IEventDecisionMap.IEventDecisionMap> => {
  const networkTrackerHostPingResponse = await performPingWithRetries(networkTrackerHost.ip, NETWORK_TRACKER_HOST_PING_TIMEOUT);

  if (networkTrackerHostPingResponse) {
    await prisma.network_tracker_hosts.update(
      {
        where: { id: networkTrackerHost.id },
        data: { consecutive_failures: 0 }
      }
    );
    
    if (networkTrackerHost.consecutive_successes < CONSECUTIVE_SUCCESSES_THRESHOLD) {
      await prisma.network_tracker_hosts.update(
        {
          where: { id: networkTrackerHost.id },
          data: { consecutive_successes: networkTrackerHost.consecutive_successes + 1 }
        }
      );
    }

    const consecutiveSucesses = networkTrackerHost.consecutive_successes < CONSECUTIVE_SUCCESSES_THRESHOLD 
      ? networkTrackerHost.consecutive_successes + 1 
      : networkTrackerHost.consecutive_successes;
  
    if (!networkTrackerHost.is_alive && consecutiveSucesses >= CONSECUTIVE_SUCCESSES_THRESHOLD) {
      return {
        code: SUCCESS_CODE,
        isAlive: true,
        shouldCreate: true
      };
    }
  } else {
    await prisma.network_tracker_hosts.update(
      {
        where: { id: networkTrackerHost.id },
        data: { consecutive_successes: 0 }
      }
    );
    
    if (networkTrackerHost.consecutive_failures < CONSECUTIVE_FAILURES_THRESHOLD) {
      await prisma.network_tracker_hosts.update(
        {
          where: { id: networkTrackerHost.id },
          data: { consecutive_failures: networkTrackerHost.consecutive_failures + 1 }
        }
      );
    }
    
    const consecutiveFailures = networkTrackerHost.consecutive_failures < CONSECUTIVE_FAILURES_THRESHOLD 
      ? networkTrackerHost.consecutive_failures + 1 
      : networkTrackerHost.consecutive_failures;

    if (networkTrackerHost.is_alive && consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
      return {
        code: FAILURE_CODE,
        isAlive: false,
        shouldCreate: true
      };
    }
  }
  
  return { shouldCreate: false };
};

export const createNetworkTrackerEvents = async (): Promise<void> => {
  try {
    const networkTrackerHostList = await prisma.network_tracker_hosts.findMany();

    await Promise.allSettled(
      networkTrackerHostList.map(
        async (networkTrackerHost: INetworkTrackerHost.INetworkTrackerHost): Promise<void> => {
          try {
            const googlePingResponse = await performPingWithRetries('google.com', GOOGLE_PING_TIMEOUT);
    
            if (googlePingResponse) {
              const eventDecisionMap = await shouldCreateEvent(networkTrackerHost);

              if (eventDecisionMap.shouldCreate) {
                const currentDate = momentTimezone().utc().toDate();
                
                if ((currentDate.getTime() - networkTrackerHost.is_alive_transition_at.getTime()) < EVENT_INTERVAL) {
                  return;
                }
  
                await prisma.network_tracker_events.create(
                  {
                    data: {
                      network_tracker_hosts_id: networkTrackerHost.id,
                      code: eventDecisionMap.code!,
                      status: 'pending'
                    }
                  }
                );
  
                await prisma.network_tracker_hosts.update(
                  {
                    where: { id: networkTrackerHost.id },
                    data: { 
                      is_alive: eventDecisionMap.isAlive,
                      is_alive_transition_at: currentDate
                    }
                  }
                );
              }
            }
          } catch (error: unknown) {
            console.log(`Error | Timestamp: ${ momentTimezone().utc().format('DD-MM-YYYY HH:mm:ss') } | Path: src/routes/createNetworkTrackerEvents.service.ts | Location: createNetworkTrackerEvents | Error: ${ error instanceof Error ? error.message : String(error) }`);
          }
        }
      )
    );
  } catch (error: unknown) {
    console.log(`Error | Timestamp: ${ momentTimezone().utc().format('DD-MM-YYYY HH:mm:ss') } | Path: src/routes/createNetworkTrackerEvents.service.ts | Location: createNetworkTrackerEvents | Error: ${ error instanceof Error ? error.message : String(error) }`);
  }
};
