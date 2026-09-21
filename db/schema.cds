namespace com.acme.slp;

using { cuid, managed } from '@sap/cds/common';

/**
 * Audit trail of every duplicate-check run, so support/ops can see what
 * outcome was returned for a given Ariba task without digging through logs.
 */
entity DuplicateCheckLog : cuid, managed {
  taskId  : String(100) @title: 'Ariba Task ID';
  outcome : String(20)  @title: 'Outcome'; // EXACT_MATCH | PARTIAL_MATCH | NO_MATCH
  matches : LargeString @title: 'Matched suppliers (JSON)';
}
