import momentTimezone from 'moment-timezone';
import { PrismaClient } from '@prisma/client/storage/client.js';
import { HttpClientUtil, BearerStrategy } from '../../expressium/src/index.js';
import { IAccountMap, IEventPayloadMap, INetworkTrackerEvent, IPartitionMap, IZoneMap } from './interfaces/index.js';

const EVENT_ID = '167617000';
const PROTOCOL_TYPE = 'CONTACT_ID';

const prisma = new PrismaClient();

export const sendNetworkTrackerEvents = async (): Promise<void> => {
  try {
    const networkTrackerEventList = await prisma.network_tracker_events.findMany({ where: { status: 'pending' } });
    const eventPayloadMapList: IEventPayloadMap.IEventPayloadMap[] = [];
    const eventIdSuccessList: number[] = [];
    const eventIdErrorList: number[] = [];

    await Promise.allSettled(
      networkTrackerEventList.forEach(
        async (networkTrackerEvent: INetworkTrackerEvent.INetworkTrackerEvent): Promise<void> => {
          const networkTrackerHost = await prisma.network_tracker_hosts.findUnique({ where: { id: networkTrackerEvent.network_tracker_hosts_id } });

          if (networkTrackerHost) {
            const httpClientInstance = new HttpClientUtil.HttpClient();

            httpClientInstance.setAuthenticationStrategy(new BearerStrategy.BearerStrategy(process.env.SIGMA_CLOUD_BEARER_TOKEN as string));
        
            const accountMap = (await httpClientInstance.get<IAccountMap.IAccountMap>(`https://api.segware.com.br/v5/accounts/${ networkTrackerHost.account_id }`)).data;

            if (!accountMap) {
              eventIdErrorList.push(networkTrackerEvent.id);

              return;
            }

            const partitionMap = accountMap.partitions.find((partitionMap: IPartitionMap.IPartitionMap): boolean => partitionMap.id === Number(networkTrackerHost.partition_id));
        
            if (!partitionMap) {
              eventIdErrorList.push(networkTrackerEvent.id);

              return;
            }

            let zoneMap: IZoneMap.IZoneMap | undefined;

            if (networkTrackerHost.zone_id) {
              const zoneMapList = (await httpClientInstance.get<IZoneMap.IZoneMap[]>(`https://api.segware.com.br/v2/accounts/${ networkTrackerHost.account_id }/zones`)).data;

              zoneMap = zoneMapList.find((zoneMap: IZoneMap.IZoneMap): boolean => zoneMap.id === Number(networkTrackerHost.zone_id) && zoneMap.partition.id === partitionMap.id);
            }

            eventIdSuccessList.push(networkTrackerEvent.id);

            eventPayloadMapList.push(
              {
                account: accountMap.accountCode,
                auxiliary: zoneMap?.zoneCode,
                code: networkTrackerEvent.code,
                companyId: accountMap.companyId,
                complement: `IP: ${ networkTrackerHost.ip }, Descrição: ${ networkTrackerHost.description }`,
                dateTime: networkTrackerEvent.created_at.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '-'),
                eventId: EVENT_ID,
                eventLog: `IP: ${ networkTrackerHost.ip }, Descrição: ${ networkTrackerHost.description }`,
                partition: partitionMap.number,
                protocolType: PROTOCOL_TYPE
              }
            );
          }
        }
      )
    );
  
    if (eventIdSuccessList.length > 0 || eventIdErrorList.length > 0) {
      const httpClientInstance = new HttpClientUtil.HttpClient();
  
      httpClientInstance.setAuthenticationStrategy(new BearerStrategy.BearerStrategy(process.env.SIGMA_CLOUD_BEARER_TOKEN as string));
    
      if (eventIdSuccessList.length > 0) {
        await httpClientInstance.post<unknown>('https://api.segware.com.br/v3/events/alarm', { events: eventPayloadMapList });
    
        await prisma.network_tracker_events.updateMany(
          {
            where: { id: { in: eventIdSuccessList } },
            data: { status: 'sent' }
          }
        );
      } else if (eventIdErrorList.length > 0) {
        await prisma.network_tracker_events.updateMany(
          {
            where: { id: { in: eventIdErrorList } },
            data: { status: 'failed' }
          }
        );
      }
    }
  } catch (error: unknown) {
    console.log(`Error | Timestamp: ${ momentTimezone().utc().format('DD-MM-YYYY HH:mm:ss') } | Path: src/routes/sendNetworkTrackerEvents.service.ts | Location: sendNetworkTrackerEvents | Error: ${ error instanceof Error ? error.message : String(error) }`);
  }
};
