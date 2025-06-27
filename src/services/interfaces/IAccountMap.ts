import { IPartitionMap } from "./index.js";

export interface IAccountMap { 
  accountCode: string;
  companyId: string;
  partitions: IPartitionMap.IPartitionMap[];
}
