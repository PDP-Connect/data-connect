-- @terminator: one
SELECT ci.status,
       EXISTS (
         SELECT 1 FROM collection_run_sequences AS rs
          WHERE rs.connector_instance_id = ci.connector_instance_id
            AND rs.storage_epoch = ci.storage_epoch
       ) AS current_epoch_run_sequence_issued
  FROM connector_instances AS ci
 WHERE ci.connector_instance_id = ?
LIMIT 1;
