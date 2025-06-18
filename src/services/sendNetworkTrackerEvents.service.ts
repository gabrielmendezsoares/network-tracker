import momentTimezone from 'moment-timezone';
import { PrismaClient } from '@prisma/client/storage/client.js';
import { HttpClientUtil, BearerStrategy } from '../../expressium/src/index.js';
import { INetworkTrackerEvent } from '../interfaces/index.js';

const EVENT_ID = '167617000';
const COMPLEMENT = 'INTERNET';
const PROTOCOL_TYPE = 'CONTACT_ID';

const prisma = new PrismaClient();

export const sendNetworkTrackerEvents = async (): Promise<void> => {
  try {
    const networkTrackerEventList = await prisma.network_tracker_events.findMany({ where: { status: 'pending' } });
    const eventIdList: number[] = [];
    const eventPayloadList: any[] = [];

    await Promise.allSettled(
      networkTrackerEventList.map(
        async (networkTrackerEvent: INetworkTrackerEvent.INetworkTrackerEvent): Promise<void> => {
          const networkTrackerHost = await prisma.network_tracker_hosts.findUnique({ where: { id: networkTrackerEvent.host_id } });

          if (networkTrackerHost) {
            eventIdList.push(networkTrackerEvent.id);

            eventPayloadList.push(
              {
                account: networkTrackerHost.account,
                auxiliary: networkTrackerHost.zone,
                code: networkTrackerEvent.code,
                companyId: networkTrackerHost.company_id,
                complement: COMPLEMENT,
                dateTime: networkTrackerEvent.created_at.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '-'),
                eventId: EVENT_ID,
                eventLog: `Company ID: ${ networkTrackerHost.company_id }, IP: ${ networkTrackerHost.ip }`,
                partition: networkTrackerHost.partition,
                protocolType: PROTOCOL_TYPE
              }
            );
          }
        }
      )
    );
  
    if (eventIdList.length > 0) {
      const httpClientInstance = new HttpClientUtil.HttpClient();
  
      httpClientInstance.setAuthenticationStrategy(new BearerStrategy.BearerStrategy(process.env.SIGMA_CLOUD_BEARER_TOKEN as string));
    
      await httpClientInstance.post<unknown>('https://api.segware.com.br/v3/events/alarm', { events: eventPayloadList });
  
      await prisma.network_tracker_events.updateMany(
        {
          where: { id: { in: eventIdList } },
          data: { status: 'sent' }
        }
      );
    }
  } catch (error: unknown) {
    console.log(`Error | Timestamp: ${ momentTimezone().utc().format('DD-MM-YYYY HH:mm:ss') } | Path: src/routes/sendNetworkTrackerEvents.service.ts | Location: sendNetworkTrackerEvents | Error: ${ error instanceof Error ? error.message : String(error) }`);
  }
};
