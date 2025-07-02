import { IPartitionMap } from './index.js';

export interface IZoneMap { 
  id: number;
  partition: IPartitionMap.IPartitionMap;
  zoneCode: string;
}
