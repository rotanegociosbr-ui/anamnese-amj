begin;

create index if not exists crm_site_booking_requests_handled_by_idx
  on private.crm_site_booking_requests (handled_by)
  where handled_by is not null;

create index if not exists crm_site_booking_operations_actor_idx
  on private.crm_site_booking_operations (actor_id);

commit;
