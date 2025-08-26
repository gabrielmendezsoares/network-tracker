import momentTimezone from 'moment-timezone';
import ping from 'ping';
import { network_tracker_hosts, PrismaClient } from '@prisma/client/storage/client.js';
import { HttpClientUtil, loggerUtil, BearerStrategy } from '../../expressium/index.js';
import { IAccountMap, IEventDecisionMap, IPartitionMap, IZoneMap } from './interfaces/index.js';

const GOOGLE_PING_TIMEOUT = 8;
const PING_ATTEMPTS = 4;
const PING_ATTEMPT_INTERVAL = 4_000;
const NETWORK_TRACKER_HOST_PING_TIMEOUT = 8;
const CONSECUTIVE_SUCCESSES_THRESHOLD = 4;
const SUCCESS_EVENT_CODE = 'R361';
const CONSECUTIVE_FAILURES_THRESHOLD = 4;
const FAILURE_EVENT_CODE = 'E361';
const EVENT_INTERVAL = 600_000;
const EVENT_ID = '167616000';
const PROTOCOL_TYPE = 'CONTACT_ID';

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
      loggerUtil.error(error instanceof Error ? error.message : String(error));
    }
    
    if (attempt < retries) {
      await new Promise<unknown>((resolve: (value: unknown) => void): NodeJS.Timeout => setTimeout(resolve, PING_ATTEMPT_INTERVAL));
    }
  }
  
  return false;
};

const shouldCreateEvent = async (networkTrackerHost: network_tracker_hosts): Promise<IEventDecisionMap.IEventDecisionMap> => {
  const networkTrackerHostPingResponse = await performPingWithRetries(networkTrackerHost.ip, NETWORK_TRACKER_HOST_PING_TIMEOUT);

  if (networkTrackerHostPingResponse) {
    await prisma.network_tracker_hosts.update(
      {
        where: { id: networkTrackerHost.id },
        data: { 
          consecutive_failures: 0,
          updated_at: momentTimezone().utc().toDate()
        }
      }
    );
    
    if (networkTrackerHost.consecutive_successes < CONSECUTIVE_SUCCESSES_THRESHOLD) {
      await prisma.network_tracker_hosts.update(
        {
          where: { id: networkTrackerHost.id },
          data: { 
            consecutive_successes: networkTrackerHost.consecutive_successes + 1,
            updated_at: momentTimezone().utc().toDate()
          }
        }
      );
    }

    const consecutiveSucesses = networkTrackerHost.consecutive_successes < CONSECUTIVE_SUCCESSES_THRESHOLD 
      ? networkTrackerHost.consecutive_successes + 1 
      : networkTrackerHost.consecutive_successes;
  
    if (!networkTrackerHost.is_alive && consecutiveSucesses >= CONSECUTIVE_SUCCESSES_THRESHOLD) {
      return {
        code: SUCCESS_EVENT_CODE,
        isAlive: true,
        shouldCreate: true
      };
    }
  } else {
    await prisma.network_tracker_hosts.update(
      {
        where: { id: networkTrackerHost.id },
        data: { 
          consecutive_successes: 0,
          updated_at: momentTimezone().utc().toDate()
        }
      }
    );
    
    if (networkTrackerHost.consecutive_failures < CONSECUTIVE_FAILURES_THRESHOLD) {
      await prisma.network_tracker_hosts.update(
        {
          where: { id: networkTrackerHost.id },
          data: { 
            consecutive_failures: networkTrackerHost.consecutive_failures + 1,
            updated_at: momentTimezone().utc().toDate()
          }
        }
      );
    }
    
    const consecutiveFailures = networkTrackerHost.consecutive_failures < CONSECUTIVE_FAILURES_THRESHOLD 
      ? networkTrackerHost.consecutive_failures + 1 
      : networkTrackerHost.consecutive_failures;

    if (networkTrackerHost.is_alive && consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
      return {
        code: FAILURE_EVENT_CODE,
        isAlive: false,
        shouldCreate: true
      };
    }
  }
  
  return { shouldCreate: false };
};

export const createSigmaCloudEvents = async (): Promise<void> => {
  try {
    const httpClientInstance = new HttpClientUtil.HttpClient();
    const networkTrackerHostList = await prisma.network_tracker_hosts.findMany({ where: { is_network_tracker_host_active: true } });

    httpClientInstance.setAuthenticationStrategy(new BearerStrategy.BearerStrategy(process.env.SIGMA_CLOUD_BEARER_TOKEN as string));

    await Promise.allSettled(
      networkTrackerHostList.map(
        async (networkTrackerHost: network_tracker_hosts): Promise<void> => {
          const googlePingResponse = await performPingWithRetries('google.com', GOOGLE_PING_TIMEOUT);
  
          if (!googlePingResponse) {
            return;
          }

          const eventDecisionMap = await shouldCreateEvent(networkTrackerHost);

          if (!eventDecisionMap.shouldCreate) {
            return;
          }

          const currentDate = momentTimezone().utc().toDate();
          
          if ((currentDate.getTime() - networkTrackerHost.is_alive_transition_at.getTime()) < EVENT_INTERVAL) {
            return;
          }

          const accountMap = (await httpClientInstance.get<IAccountMap.IAccountMap>(`https://api.segware.com.br/v5/accounts/${ networkTrackerHost.account_id }`)).data;

          if (!accountMap) {
            return;
          }

          const partitionMap = accountMap.partitions.find((partitionMap: IPartitionMap.IPartitionMap): boolean => partitionMap.id === networkTrackerHost.partition_id);
      
          if (!partitionMap) {
            return;
          }

          let zoneMap: IZoneMap.IZoneMap | undefined;

          if (networkTrackerHost.zone_id) {
            const zoneMapList = (await httpClientInstance.get<IZoneMap.IZoneMap[]>(`https://api.segware.com.br/v2/accounts/${ networkTrackerHost.account_id }/zones`)).data;

            zoneMap = zoneMapList.find((zoneMap: IZoneMap.IZoneMap): boolean => zoneMap.id === networkTrackerHost.zone_id && zoneMap.partition.id === partitionMap.id);
          }

          try {            
            await httpClientInstance.post<unknown>(
              'https://api.segware.com.br/v3/events/alarm', 
              { 
                events: [
                  {
                    account: accountMap.accountCode,
                    auxiliary: zoneMap?.zoneCode ?? '100',
                    code: eventDecisionMap.code as string,
                    companyId: accountMap.companyId,
                    complement: `IP: ${ networkTrackerHost.ip }, Local: ${ networkTrackerHost.description }`,
                    eventId: EVENT_ID,
                    eventLog: `IP: ${ networkTrackerHost.ip }, Local: ${ networkTrackerHost.description }`,
                    partition: partitionMap.number,
                    protocolType: PROTOCOL_TYPE
                  }
                ] 
              }
            );

            await prisma.sigma_cloud_alarm_events.create(
              {
                data: {
                  application_type: 'network-tracker',
                  account: accountMap.accountCode,
                  auxiliary: zoneMap?.zoneCode ?? '100',
                  code: eventDecisionMap.code as string,
                  company_id: accountMap.companyId,
                  complement: `IP: ${ networkTrackerHost.ip }, Local: ${ networkTrackerHost.description }`,
                  event_id: EVENT_ID,
                  event_log: `IP: ${ networkTrackerHost.ip }, Local: ${ networkTrackerHost.description }`,
                  partition: partitionMap.number,
                  protocol_type: PROTOCOL_TYPE,
                  status: 'sent'
                }
              }
            );

            try {
              await prisma.network_tracker_hosts.update(
                {
                  where: { id: networkTrackerHost.id },
                  data: { 
                    is_alive: eventDecisionMap.isAlive,
                    is_alive_transition_at: currentDate,
                    updated_at: currentDate
                  }
                }
              );  
            } catch (error: unknown) {
              loggerUtil.error(error instanceof Error ? error.message : String(error));
            }
          } catch (error: unknown) {
            loggerUtil.error(error instanceof Error ? error.message : String(error));

            await prisma.sigma_cloud_alarm_events.create(
              {
                data: {
                  application_type: 'network-tracker',
                  account: accountMap.accountCode,
                  auxiliary: zoneMap?.zoneCode ?? '100',
                  code: eventDecisionMap.code as string,
                  company_id: accountMap.companyId,
                  complement: `IP: ${ networkTrackerHost.ip }, Local: ${ networkTrackerHost.description }`,
                  event_id: EVENT_ID,
                  event_log: `IP: ${ networkTrackerHost.ip }, Local: ${ networkTrackerHost.description }`,
                  partition: partitionMap.number,
                  protocol_type: PROTOCOL_TYPE,
                  status: 'failed'
                }
              }
            );
          }
        }
      )
    );
  } catch (error: unknown) {
    loggerUtil.error(error instanceof Error ? error.message : String(error));
  }
};
