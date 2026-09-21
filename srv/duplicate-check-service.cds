using com.acme.slp as db from '../db/schema';

/**
 * Exposed at /api (see path annotation). REST protocol turns the unbound
 * action below into:
 *
 *   POST /api/runDuplicateCheck   { "taskId": "TSK123" }
 *
 * This is the endpoint the Ariba approval flow's custom node calls when a
 * Supplier Request questionnaire reaches the Duplicate Supplier Validation
 * step.
 */
service DuplicateCheckService @(path: '/api', protocol: 'rest') {

  @readonly
  entity DuplicateCheckLogs as projection on db.DuplicateCheckLog;

  action runDuplicateCheck(taskId: String) returns {
    outcome : String;
    taskId  : String;
    matches : array of {
      name  : String;
      email : String;
    };
  };
}
