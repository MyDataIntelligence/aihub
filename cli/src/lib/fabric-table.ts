/** Declarative Fabric REST rows ported from the legacy Hub tool table (one row per tool). Generated once; edit by hand. */
export interface FabricRow {
  name: string;
  method: string;
  /** Relative to the Fabric API, or an absolute URL (Power BI). {ws} {item} and {any} are filled from --workspace --item --arg. */
  url: string;
  write?: boolean;
  lro?: boolean;
  paged?: boolean;
  data?: boolean;
  key?: string;
  res?: string;
  noun?: string;
  phrase?: string;
  /** Query parameters: `name` or `name=arg`. */
  q?: string[];
  /** Body fields from --arg: `arg` or `arg>jsonKey`. */
  body?: string[];
  /** The body is built by the legacy tool from several arguments: pass it with --body-file. */
  bodyFile?: boolean;
}

export const FABRIC_ROWS: FabricRow[] = [
  {
    "name": "get_workspace",
    "method": "GET",
    "url": "workspaces/{ws}"
  },
  {
    "name": "create_workspace",
    "method": "POST",
    "url": "workspaces",
    "write": true,
    "lro": true,
    "phrase": "Create the Fabric workspace '{displayName}'",
    "body": [
      "displayName",
      "description",
      "capacityId"
    ]
  },
  {
    "name": "update_workspace",
    "method": "PATCH",
    "url": "workspaces/{ws}",
    "write": true,
    "phrase": "Change the name or description of Fabric workspace '{ws}'",
    "body": [
      "displayName",
      "description"
    ]
  },
  {
    "name": "delete_workspace",
    "method": "DELETE",
    "url": "workspaces/{ws}",
    "write": true,
    "phrase": "Delete the Fabric feature workspace '{ws}' with all its items"
  },
  {
    "name": "provision_workspace_identity",
    "method": "POST",
    "url": "workspaces/{ws}/provisionIdentity",
    "write": true,
    "lro": true,
    "phrase": "Provision the workspace identity of Fabric workspace '{ws}'"
  },
  {
    "name": "list_capacities",
    "method": "GET",
    "url": "capacities",
    "paged": true,
    "noun": "capacities"
  },
  {
    "name": "assign_capacity",
    "method": "POST",
    "url": "workspaces/{ws}/assignToCapacity",
    "write": true,
    "phrase": "Move Fabric workspace '{ws}' to capacity {capacityId}",
    "body": [
      "capacityId"
    ]
  },
  {
    "name": "unassign_capacity",
    "method": "POST",
    "url": "workspaces/{ws}/unassignFromCapacity",
    "write": true,
    "phrase": "Take Fabric workspace '{ws}' off its capacity"
  },
  {
    "name": "list_domains",
    "method": "GET",
    "url": "admin/domains",
    "paged": true,
    "key": "domains",
    "noun": "domains"
  },
  {
    "name": "assign_domain",
    "method": "POST",
    "url": "admin/domains/{domainId}/assignWorkspaces",
    "write": true,
    "phrase": "Assign Fabric workspace '{ws}' to domain {domainId}",
    "bodyFile": true
  },
  {
    "name": "list_workspace_role_assignments",
    "method": "GET",
    "url": "workspaces/{ws}/roleAssignments",
    "paged": true,
    "noun": "role assignments"
  },
  {
    "name": "add_workspace_role_assignment",
    "method": "POST",
    "url": "workspaces/{ws}/roleAssignments",
    "write": true,
    "phrase": "Give {principalType} {principalId} the role {role} on Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "delete_workspace_role_assignment",
    "method": "DELETE",
    "url": "workspaces/{ws}/roleAssignments/{roleAssignmentId}",
    "write": true,
    "phrase": "Remove role assignment {roleAssignmentId} from Fabric workspace '{ws}'"
  },
  {
    "name": "get_workspace_network",
    "method": "GET",
    "url": "workspaces/{ws}/networking/communicationPolicy"
  },
  {
    "name": "list_private_endpoints",
    "method": "GET",
    "url": "workspaces/{ws}/managedPrivateEndpoints",
    "paged": true,
    "noun": "private endpoints"
  },
  {
    "name": "create_private_endpoint",
    "method": "POST",
    "url": "workspaces/{ws}/managedPrivateEndpoints",
    "write": true,
    "phrase": "Create managed private endpoint '{name}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "delete_private_endpoint",
    "method": "DELETE",
    "url": "workspaces/{ws}/managedPrivateEndpoints/{endpointId}",
    "write": true,
    "phrase": "Delete managed private endpoint {endpointId} of Fabric workspace '{ws}'"
  },
  {
    "name": "list_gateways",
    "method": "GET",
    "url": "gateways",
    "paged": true,
    "noun": "gateways"
  },
  {
    "name": "get_gateway",
    "method": "GET",
    "url": "gateways/{gatewayId}"
  },
  {
    "name": "list_items",
    "method": "GET",
    "url": "workspaces/{ws}/items",
    "paged": true,
    "q": [
      "type",
      "rootFolderId=folderId",
      "recursive"
    ]
  },
  {
    "name": "get_item",
    "method": "GET",
    "url": "workspaces/{ws}/items/{item}"
  },
  {
    "name": "create_item",
    "method": "POST",
    "url": "workspaces/{ws}/items",
    "write": true,
    "lro": true,
    "phrase": "Create the {itemType} '{displayName}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "update_item",
    "method": "PATCH",
    "url": "workspaces/{ws}/items/{item}",
    "write": true,
    "phrase": "Change the name or description of item '{item}' in Fabric workspace '{ws}'",
    "body": [
      "displayName",
      "description"
    ]
  },
  {
    "name": "delete_item",
    "method": "DELETE",
    "url": "workspaces/{ws}/items/{item}",
    "write": true,
    "phrase": "Delete item '{item}' from Fabric workspace '{ws}'"
  },
  {
    "name": "move_item",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/move",
    "write": true,
    "phrase": "Move item '{item}' in Fabric workspace '{ws}' to another folder",
    "body": [
      "targetFolderId"
    ]
  },
  {
    "name": "get_definition",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/getDefinition",
    "lro": true,
    "data": true,
    "q": [
      "format"
    ],
    "bodyFile": true
  },
  {
    "name": "update_item_definition",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/updateDefinition",
    "write": true,
    "lro": true,
    "phrase": "Replace the definition of item '{item}' in Fabric workspace '{ws}'",
    "q": [
      "updateMetadata"
    ],
    "body": [
      "definition"
    ]
  },
  {
    "name": "get_item_connections",
    "method": "GET",
    "url": "workspaces/{ws}/items/{item}/connections",
    "paged": true,
    "noun": "connections"
  },
  {
    "name": "list_folders",
    "method": "GET",
    "url": "workspaces/{ws}/folders",
    "paged": true,
    "noun": "folders",
    "q": [
      "rootFolderId=folderId",
      "recursive"
    ]
  },
  {
    "name": "create_folder",
    "method": "POST",
    "url": "workspaces/{ws}/folders",
    "write": true,
    "phrase": "Create folder '{displayName}' in Fabric workspace '{ws}'",
    "body": [
      "displayName",
      "parentFolderId"
    ]
  },
  {
    "name": "rename_folder",
    "method": "PATCH",
    "url": "workspaces/{ws}/folders/{folderId}",
    "write": true,
    "phrase": "Rename folder {folderId} of Fabric workspace '{ws}' to '{displayName}'",
    "body": [
      "displayName"
    ]
  },
  {
    "name": "delete_folder",
    "method": "DELETE",
    "url": "workspaces/{ws}/folders/{folderId}",
    "write": true,
    "phrase": "Delete folder {folderId} of Fabric workspace '{ws}'"
  },
  {
    "name": "list_tags",
    "method": "GET",
    "url": "tags",
    "paged": true
  },
  {
    "name": "apply_tags",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/applyTags",
    "write": true,
    "phrase": "Apply tags to item '{item}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "unapply_tags",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/unapplyTags",
    "write": true,
    "phrase": "Remove tags from item '{item}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "get_git_connection",
    "method": "GET",
    "url": "workspaces/{ws}/git/connection"
  },
  {
    "name": "get_git_status",
    "method": "GET",
    "url": "workspaces/{ws}/git/status",
    "lro": true
  },
  {
    "name": "get_my_git_credentials",
    "method": "GET",
    "url": "workspaces/{ws}/git/myGitCredentials"
  },
  {
    "name": "connect_git",
    "method": "POST",
    "url": "workspaces/{ws}/git/connect",
    "write": true,
    "phrase": "Connect Fabric workspace '{ws}' to its Git branch",
    "bodyFile": true
  },
  {
    "name": "disconnect_git",
    "method": "POST",
    "url": "workspaces/{ws}/git/disconnect",
    "write": true,
    "phrase": "Disconnect Fabric workspace '{ws}' from Git (its items stay)"
  },
  {
    "name": "initialize_git_connection",
    "method": "POST",
    "url": "workspaces/{ws}/git/initializeConnection",
    "write": true,
    "lro": true,
    "phrase": "Initialise the Git connection of Fabric workspace '{ws}'",
    "body": [
      "initializationStrategy"
    ]
  },
  {
    "name": "commit_to_git",
    "method": "POST",
    "url": "workspaces/{ws}/git/commitToGit",
    "write": true,
    "lro": true,
    "phrase": "Commit the changed items of Fabric workspace '{ws}' to its Git branch",
    "bodyFile": true
  },
  {
    "name": "update_from_git",
    "method": "POST",
    "url": "workspaces/{ws}/git/updateFromGit",
    "write": true,
    "lro": true,
    "phrase": "Update Fabric workspace '{ws}' from its Git branch (the workspace changes to the branch content)",
    "bodyFile": true
  },
  {
    "name": "update_my_git_credentials",
    "method": "PATCH",
    "url": "workspaces/{ws}/git/myGitCredentials",
    "write": true,
    "phrase": "Set the Git credentials source of Fabric workspace '{ws}' to {source}",
    "bodyFile": true
  },
  {
    "name": "list_deployment_pipelines",
    "method": "GET",
    "url": "deploymentPipelines",
    "paged": true,
    "noun": "deployment pipelines"
  },
  {
    "name": "cancel_job",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/jobs/instances/{runId}/cancel",
    "write": true,
    "phrase": "Cancel run {runId} of item '{item}' in Fabric workspace '{ws}'"
  },
  {
    "name": "list_schedules",
    "method": "GET",
    "url": "workspaces/{ws}/items/{item}/jobs/{jobType}/schedules",
    "paged": true,
    "noun": "schedules"
  },
  {
    "name": "create_schedule",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/jobs/{jobType}/schedules",
    "write": true,
    "phrase": "Create a schedule for item '{item}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "update_schedule",
    "method": "PATCH",
    "url": "workspaces/{ws}/items/{item}/jobs/{jobType}/schedules/{scheduleId}",
    "write": true,
    "phrase": "Change schedule {scheduleId} of item '{item}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "delete_schedule",
    "method": "DELETE",
    "url": "workspaces/{ws}/items/{item}/jobs/{jobType}/schedules/{scheduleId}",
    "write": true,
    "phrase": "Delete schedule {scheduleId} of item '{item}' in Fabric workspace '{ws}'"
  },
  {
    "name": "list_lakehouse_tables",
    "method": "GET",
    "url": "workspaces/{ws}/lakehouses/{item}/tables?maxResults=100",
    "paged": true,
    "key": "data",
    "noun": "tables"
  },
  {
    "name": "load_table",
    "method": "POST",
    "url": "workspaces/{ws}/lakehouses/{item}/tables/{tableName}/load",
    "write": true,
    "lro": true,
    "phrase": "Load {relativePath} into table {tableName} ({mode}) of '{item}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "refresh_sql_endpoint",
    "method": "POST",
    "url": "workspaces/{ws}/sqlEndpoints/{sqlEndpointId}/refreshMetadata",
    "write": true,
    "lro": true,
    "phrase": "Sync the SQL analytics endpoint of '{ws}' with its Delta tables",
    "bodyFile": true
  },
  {
    "name": "list_shortcuts",
    "method": "GET",
    "url": "workspaces/{ws}/items/{item}/shortcuts",
    "paged": true,
    "noun": "shortcuts",
    "q": [
      "parentPath"
    ]
  },
  {
    "name": "get_shortcut",
    "method": "GET",
    "url": "workspaces/{ws}/items/{item}/shortcuts/{path}/{shortcutName}"
  },
  {
    "name": "create_shortcut",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/shortcuts",
    "write": true,
    "phrase": "Create shortcut '{shortcutName}' under {path} of '{item}' in Fabric workspace '{ws}'",
    "q": [
      "shortcutConflictPolicy=conflictPolicy"
    ],
    "bodyFile": true
  },
  {
    "name": "delete_shortcut",
    "method": "DELETE",
    "url": "workspaces/{ws}/items/{item}/shortcuts/{path}/{shortcutName}",
    "write": true,
    "phrase": "Delete shortcut '{shortcutName}' under {path} of '{item}' in Fabric workspace '{ws}' (the target data stays)"
  },
  {
    "name": "list_data_access_roles",
    "method": "GET",
    "url": "workspaces/{ws}/items/{item}/dataAccessRoles"
  },
  {
    "name": "set_data_access_roles",
    "method": "PUT",
    "url": "workspaces/{ws}/items/{item}/dataAccessRoles",
    "write": true,
    "phrase": "Replace the OneLake data access roles of '{item}' in Fabric workspace '{ws}'",
    "q": [
      "dryRun"
    ],
    "bodyFile": true
  },
  {
    "name": "list_data_shares",
    "method": "GET",
    "url": "workspaces/{ws}/items/{item}/externalDataShares",
    "paged": true,
    "noun": "data shares"
  },
  {
    "name": "create_data_share",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/externalDataShares",
    "write": true,
    "phrase": "Share data of '{item}' in Fabric workspace '{ws}' with {recipientUserPrincipalName}",
    "bodyFile": true
  },
  {
    "name": "revoke_data_share",
    "method": "POST",
    "url": "workspaces/{ws}/items/{item}/externalDataShares/{shareId}/revoke",
    "write": true,
    "phrase": "Revoke data share {shareId} of '{item}' in Fabric workspace '{ws}'"
  },
  {
    "name": "refresh_semantic_model",
    "method": "POST",
    "url": "https://api.powerbi.com/v1.0/myorg/groups/{ws}/datasets/{item}/refreshes",
    "write": true,
    "lro": true,
    "res": "pbi",
    "phrase": "Refresh semantic model '{item}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "delete_environment_library",
    "method": "DELETE",
    "url": "workspaces/{ws}/environments/{item}/staging/libraries/{library}",
    "write": true,
    "phrase": "Remove library {library} from the staging of environment '{item}' in Fabric workspace '{ws}'"
  },
  {
    "name": "update_environment_spark_compute",
    "method": "PATCH",
    "url": "workspaces/{ws}/environments/{item}/staging/sparkcompute?beta=false",
    "write": true,
    "phrase": "Change the staging Spark compute of environment '{item}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "update_spark_settings",
    "method": "PATCH",
    "url": "workspaces/{ws}/spark/settings",
    "write": true,
    "phrase": "Change the Spark settings of Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "set_mirroring",
    "method": "POST",
    "url": "workspaces/{ws}/mirroredDatabases/{item}/{action}Mirroring",
    "write": true,
    "phrase": "{action} mirroring of '{item}' in Fabric workspace '{ws}'"
  },
  {
    "name": "set_active_value_set",
    "method": "PATCH",
    "url": "workspaces/{ws}/variableLibraries/{item}",
    "write": true,
    "phrase": "Make value set '{valueSet}' the active one of variable library '{item}' in Fabric workspace '{ws}'",
    "bodyFile": true
  },
  {
    "name": "list_connections",
    "method": "GET",
    "url": "connections",
    "paged": true,
    "noun": "connections"
  },
  {
    "name": "get_connection",
    "method": "GET",
    "url": "connections/{connectionId}"
  },
  {
    "name": "list_connection_types",
    "method": "GET",
    "url": "connections/supportedConnectionTypes",
    "paged": true,
    "noun": "connection types",
    "q": [
      "gatewayId"
    ]
  },
  {
    "name": "list_connection_role_assignments",
    "method": "GET",
    "url": "connections/{connectionId}/roleAssignments",
    "paged": true,
    "noun": "role assignments"
  },
  {
    "name": "add_connection_role_assignment",
    "method": "POST",
    "url": "connections/{connectionId}/roleAssignments",
    "write": true,
    "phrase": "Give {principalType} {principalId} the role {role} on connection {connectionId}",
    "bodyFile": true
  },
  {
    "name": "delete_connection_role_assignment",
    "method": "DELETE",
    "url": "connections/{connectionId}/roleAssignments/{roleAssignmentId}",
    "write": true,
    "phrase": "Remove role assignment {roleAssignmentId} from connection {connectionId}"
  },
  {
    "name": "get_operation",
    "method": "GET",
    "url": "operations/{operationId}"
  },
  {
    "name": "get_operation_result",
    "method": "GET",
    "url": "operations/{operationId}/result"
  },
  {
    "name": "get_mirroring_status",
    "method": "POST",
    "url": "workspaces/{ws}/mirroredDatabases/{item}/getMirroringStatus"
  },
  {
    "name": "get_variable_library",
    "method": "GET",
    "url": "workspaces/{ws}/variableLibraries/{item}"
  },
  {
    "name": "get_eventstream",
    "method": "GET",
    "url": "workspaces/{ws}/eventstreams/{item}"
  },
  {
    "name": "get_spark_settings",
    "method": "GET",
    "url": "workspaces/{ws}/spark/settings"
  },
  {
    "name": "get_environment",
    "method": "GET",
    "url": "workspaces/{ws}/environments/{item}"
  },
  {
    "name": "list_spark_sessions",
    "method": "GET",
    "url": "workspaces/{ws}/spark/livySessions",
    "paged": true,
    "noun": "Spark sessions"
  },
  {
    "name": "list_custom_pools",
    "method": "GET",
    "url": "workspaces/{ws}/spark/pools",
    "paged": true,
    "noun": "custom pools"
  },
  {
    "name": "get_domain",
    "method": "GET",
    "url": "admin/domains/{domainId}"
  },
  {
    "name": "list_domain_workspaces",
    "method": "GET",
    "url": "admin/domains/{domainId}/workspaces",
    "paged": true,
    "noun": "workspaces"
  },
  {
    "name": "get_deployment_pipeline",
    "method": "GET",
    "url": "deploymentPipelines/{deploymentPipelineId}"
  },
  {
    "name": "list_deployment_stage_items",
    "method": "GET",
    "url": "deploymentPipelines/{deploymentPipelineId}/stages/{stageId}/items",
    "paged": true,
    "noun": "items"
  },
  {
    "name": "list_deployment_operations",
    "method": "GET",
    "url": "deploymentPipelines/{deploymentPipelineId}/operations",
    "paged": true,
    "noun": "operations"
  },
  {
    "name": "get_ml_model_endpoint",
    "method": "GET",
    "url": "workspaces/{ws}/mlmodels/{item}/endpoint"
  },
  {
    "name": "get_ml_model_endpoint_versions",
    "method": "GET",
    "url": "workspaces/{ws}/mlmodels/{item}/endpoint/versions",
    "paged": true,
    "noun": "versions"
  },
  {
    "name": "get_eventstream_topology",
    "method": "GET",
    "url": "workspaces/{ws}/eventstreams/{item}/topology"
  },
  {
    "name": "set_eventstream_state",
    "method": "POST",
    "url": "workspaces/{ws}/eventstreams/{item}/topology/{action}",
    "write": true,
    "phrase": "{action} eventstream {item} in workspace {ws} (action pause or resume; body {startType: Now} to resume)",
    "body": [
      "startType",
      "customStartDateTime"
    ]
  },
  {
    "name": "set_eventstream_source_state",
    "method": "POST",
    "url": "workspaces/{ws}/eventstreams/{item}/topology/sources/{sourceId}/{action}",
    "write": true,
    "phrase": "{action} source {sourceId} of eventstream {item}",
    "body": [
      "startType",
      "customStartDateTime"
    ]
  },
  {
    "name": "set_eventstream_destination_state",
    "method": "POST",
    "url": "workspaces/{ws}/eventstreams/{item}/topology/destinations/{destinationId}/{action}",
    "write": true,
    "phrase": "{action} destination {destinationId} of eventstream {item}",
    "body": [
      "startType",
      "customStartDateTime"
    ]
  },
  {
    "name": "discover_databricks_catalog",
    "method": "GET",
    "url": "workspaces/{ws}/azureDatabricks/catalogs",
    "paged": true,
    "noun": "catalogs",
    "q": [
      "databricksWorkspaceConnectionId=connectionId",
      "maxResults"
    ]
  },
  {
    "name": "discover_databricks_schemas",
    "method": "GET",
    "url": "workspaces/{ws}/azureDatabricks/catalogs/{catalog}/schemas",
    "paged": true,
    "noun": "schemas",
    "q": [
      "databricksWorkspaceConnectionId=connectionId",
      "maxResults"
    ]
  },
  {
    "name": "discover_databricks_tables",
    "method": "GET",
    "url": "workspaces/{ws}/azureDatabricks/catalogs/{catalog}/schemas/{schema}/tables",
    "paged": true,
    "noun": "tables",
    "q": [
      "databricksWorkspaceConnectionId=connectionId",
      "maxResults"
    ]
  },
  {
    "name": "get_lakehouse",
    "method": "GET",
    "url": "workspaces/{ws}/lakehouses/{item}"
  },
  {
    "name": "get_warehouse",
    "method": "GET",
    "url": "workspaces/{ws}/warehouses/{item}"
  },
  {
    "name": "get_mirrored_database",
    "method": "GET",
    "url": "workspaces/{ws}/mirroredDatabases/{item}"
  },
  {
    "name": "save_custom_pool",
    "method": "POST",
    "url": "workspaces/{ws}/spark/pools",
    "write": true,
    "phrase": "Create a custom Spark pool in workspace {ws}",
    "bodyFile": true
  },
  {
    "name": "update_custom_pool",
    "method": "PATCH",
    "url": "workspaces/{ws}/spark/pools/{poolId}",
    "write": true,
    "phrase": "Update custom Spark pool {poolId} in workspace {ws}",
    "bodyFile": true
  }
];
