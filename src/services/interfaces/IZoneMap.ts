import { IPartitionMap } from './index.js';

export interface IZoneMap { 
  zoneCode: string;
  partition: IPartitionMap.IPartitionMap;
}
