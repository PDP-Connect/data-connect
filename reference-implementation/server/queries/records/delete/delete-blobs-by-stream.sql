-- @terminator: exec
-- Stream-scoped blob-content reclaim, the per-stream sibling of
-- delete-blobs-by-instance.sql. Runs AFTER that stream's blob_bindings are
-- deleted, in the same transaction. Dropping the bindings without this left
-- the now-unreferenced blobs rows behind permanently: nothing in the codebase
-- collects orphaned blobs, so those bytes were junk forever.
--
-- Refcount-gated, not supersede-and-delete. A content-addressed blob row may
-- be shared by bindings from another connection (identical bytes dedupe to one
-- row), so retain it whenever any binding remains; otherwise the blob_bindings
-- FK would cascade a live sibling's binding away.
DELETE FROM blobs
 WHERE connector_instance_id = ?
   AND stream = ?
   AND NOT EXISTS (
     SELECT 1
       FROM blob_bindings
      WHERE blob_bindings.blob_id = blobs.blob_id
   )
