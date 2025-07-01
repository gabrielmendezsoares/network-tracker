export interface INetworkTrackerHost {
  id: number;
  ip: string;
  account_id: string;
  partition_id: string;
  consecutive_successes: number;
  consecutive_failures: number;
  is_alive: boolean;
  is_alive_transition_at: Date;
  created_at: Date;
  updated_at: Date;
}
