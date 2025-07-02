import { IPartitionMap } from "./index.js";

export interface IAccountMap { 
  accountCode: string;
  companyId: number;
  partitions: IPartitionMap.IPartitionMap[];
}
