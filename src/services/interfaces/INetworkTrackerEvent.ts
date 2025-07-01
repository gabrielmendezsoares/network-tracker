export interface INetworkTrackerEvent {
  id: number;
  network_tracker_hosts_id: number;
  code: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}
