export interface INetworkTrackerHost {
  id: number;
  ip: string;
  description: string;
  account_id: string;
  partition_id: string;
  zone_id: string | null;
  consecutive_successes: number;
  consecutive_failures: number;
  is_alive: boolean;
  is_alive_transition_at: Date;
  created_at: Date;
  updated_at: Date;
}
