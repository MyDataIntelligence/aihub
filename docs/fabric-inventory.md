# Fabric inventory: legacy tools and where they live now

Source: the legacy Hub (`MyDataIntelligence/extensions`, tag `legacy/hub-surface-v2-2026-11-17`): the Kotlin `Mcp*Fabric*` tools and the table-driven Hub Lite port `archive/copilot-lite/lib/hub_lite/tools/fabric.py` (143 tool rows). Every row is below with its REST endpoint, the `aihub fabric` command and its status. Counts: 89 with a dedicated command, 54 reachable through the generic `fabric api <tool>`, 8 dropped as obsolete (each with its reason); none is left as not yet ported.

## Rules that carry over
- Workspaces are any workspace the signed-in identity can access, by name or id; no allow-list. The workspace name decides ACC and PRD (`acc`, `acceptance`, `acceptatie`, `uat`, `prd`, `prod`, `production`, `productie`; PRD wins). Writes and runs there are refused before any call unless `--allow-env` names that environment. Reads work everywhere.
- Every write has `--dry-run`; deletes need `--yes`.
- Output is redacted (SAS signatures, bearer tokens, client secrets, connection-string passwords, JWTs, private keys).
- Read-only guards: DAX must start with EVALUATE/DEFINE, KQL control commands (`.`) and GraphQL mutations are refused, the KQL host must be `*.kusto.fabric.microsoft.com`.
- Identity: `--sp`, `AIHUB_FABRIC_SP`, `AZURE_CLIENT_*`, team.yaml `servicePrincipal`, user default SP, `AIHUB_FABRIC_TOKEN`, az user. Every `--json` result carries the identity.
- `fabric api list [--filter]` lists the generic rows; a row whose body the legacy tool assembled from several fields takes `--body-file <json>`; placeholders other than workspace and item are `--arg name=value`.
- Not live-verified: all rows are tested against synthetic REST fixtures only.

## Command surface (grouped)
`workspaces`, `workspace show|roles|create|assign-capacity`, `spark sessions|app|logs`, `livy run`, `failures`, `sql`, `connection create|update|delete`, `udf invoke`, `notebook-test prepare|run|verify`, `dbt detect|results|scaffold|run|upload|save-job|get-job`, `capacities`, `connections`, `gateways`, `items`, `item show|definition|create|update|rename|delete`, `jobs`, `job show|cancel|logs`, `status`, `run [--cancel]`, `logs`, `schedules`, `lakehouse tables|files|load|maintenance`, `shortcuts`, `onelake list|read|write|mkdir|delete|move`, `dax`, `kql`, `graphql`, `environment publish|libraries`, `git status|update|commit`, `deployment list|stages|deploy`, `auth status|sp ...`, `plan`, `api <tool>`.

## Tools

| Legacy tool | Kind | REST (relative to api.fabric.microsoft.com/v1) | Command | Status |
|---|---|---|---|---|
| auth_status | read | custom handler | `aihub fabric auth status` | ported |
| auth_test_connection | read | custom handler | `aihub fabric auth status / auth sp test` | ported |
| auth_login | read | custom handler | - | dropped: obsolete; the CLI never logs in for you, run `az login` or register a service principal |
| auth_add_service_principal | write | custom handler | `aihub fabric auth sp add` | ported |
| auth_remove_service_principal | write | custom handler | `aihub fabric auth sp remove` | ported |
| auth_set_default_service_principal | write | custom handler | `aihub fabric auth sp default` | ported |
| auth_test_service_principal | read | custom handler | `aihub fabric auth sp test` | ported |
| capabilities | read | custom handler | - | dropped: obsolete static item-type table; the skill reference lists the types |
| test_strategy | read | custom handler | `aihub fabric plan (test plan and strategy)` | ported |
| approve_workspace | write | custom handler | - | dropped: obsolete; no bookmarks or approvals, the workspace name decides ACC/PRD and `--allow-env` is the only override |
| revoke_workspace | write | custom handler | - | dropped: obsolete, see approve_workspace |
| approve_sql_reads | write | custom handler | - | dropped: obsolete; reads need no approval (read-only guards stay) |
| approve_production_reads | write | custom handler | - | dropped: obsolete; reads need no approval (read-only guards stay) |
| list_workspaces | read | custom handler | `aihub fabric workspaces` | ported |
| get_workspace | read | GET workspaces/{ws} | `aihub fabric workspace show` (also `api get_workspace`) | ported |
| create_workspace | write | POST workspaces | `aihub fabric workspace create` (also `api create_workspace`) | ported |
| update_workspace | write | PATCH workspaces/{ws} | `aihub fabric api update_workspace` | ported (generic) |
| delete_workspace | write | DELETE workspaces/{ws} | `aihub fabric api delete_workspace` | ported (generic) |
| create_feature_workspace | write | custom handler | `aihub fabric workspace create --name <DEV-...>` | ported |
| provision_workspace_identity | write | POST workspaces/{ws}/provisionIdentity | `aihub fabric api provision_workspace_identity` | ported (generic) |
| list_capacities | read | GET capacities | `aihub fabric capacities` (also `api list_capacities`) | ported |
| get_capacity | read | custom handler | `aihub fabric capacities --filter` | ported |
| assign_capacity | write | POST workspaces/{ws}/assignToCapacity | `aihub fabric workspace assign-capacity` (also `api assign_capacity`) | ported |
| unassign_capacity | write | POST workspaces/{ws}/unassignFromCapacity | `aihub fabric api unassign_capacity` | ported (generic) |
| list_domains | read | GET admin/domains | `aihub fabric api list_domains` | ported (generic) |
| get_domain | read | custom handler | `aihub fabric api get_domain` (also `api get_domain`) | ported |
| assign_domain | write | POST admin/domains/{domainId}/assignWorkspaces | `aihub fabric api assign_domain` | ported (generic) with --body-file |
| list_workspace_role_assignments | read | GET workspaces/{ws}/roleAssignments | `aihub fabric workspace roles` (also `api list_workspace_role_assignments`) | ported |
| add_workspace_role_assignment | write | POST workspaces/{ws}/roleAssignments | `aihub fabric api add_workspace_role_assignment` | ported (generic) with --body-file |
| delete_workspace_role_assignment | write | DELETE workspaces/{ws}/roleAssignments/{roleAssignmentId} | `aihub fabric api delete_workspace_role_assignment` | ported (generic) |
| get_workspace_network | read | GET workspaces/{ws}/networking/communicationPolicy | `aihub fabric api get_workspace_network` | ported (generic) |
| list_private_endpoints | read | GET workspaces/{ws}/managedPrivateEndpoints | `aihub fabric api list_private_endpoints` | ported (generic) |
| create_private_endpoint | write | POST workspaces/{ws}/managedPrivateEndpoints | `aihub fabric api create_private_endpoint` | ported (generic) with --body-file |
| delete_private_endpoint | write | DELETE workspaces/{ws}/managedPrivateEndpoints/{endpointId} | `aihub fabric api delete_private_endpoint` | ported (generic) |
| list_gateways | read | GET gateways | `aihub fabric gateways` (also `api list_gateways`) | ported |
| get_gateway | read | GET gateways/{gatewayId} | `aihub fabric api get_gateway` | ported (generic) |
| list_items | read | GET workspaces/{ws}/items | `aihub fabric items [--type]` (also `api list_items`) | ported |
| get_item | read | GET workspaces/{ws}/items/{item} | `aihub fabric item show` (also `api get_item`) | ported |
| resolve_item | read | custom handler | `aihub fabric item show (name or id, did-you-mean)` | ported |
| create_item | write | POST workspaces/{ws}/items | `aihub fabric item create` (also `api create_item`) | ported |
| update_item | write | PATCH workspaces/{ws}/items/{item} | `aihub fabric item rename` (also `api update_item`) | ported |
| delete_item | write | DELETE workspaces/{ws}/items/{item} | `aihub fabric item delete --yes` (also `api delete_item`) | ported |
| move_item | write | POST workspaces/{ws}/items/{item}/move | `aihub fabric api move_item` | ported (generic) |
| get_definition | read | POST workspaces/{ws}/items/{item}/getDefinition | `aihub fabric item definition [--out]` (also `api get_definition`) | ported |
| update_item_definition | write | POST workspaces/{ws}/items/{item}/updateDefinition | `aihub fabric item update` (also `api update_item_definition`) | ported |
| get_item_connections | read | GET workspaces/{ws}/items/{item}/connections | `aihub fabric api get_item_connections` | ported (generic) |
| list_folders | read | GET workspaces/{ws}/folders | `aihub fabric api list_folders` | ported (generic) |
| create_folder | write | POST workspaces/{ws}/folders | `aihub fabric api create_folder` | ported (generic) |
| rename_folder | write | PATCH workspaces/{ws}/folders/{folderId} | `aihub fabric api rename_folder` | ported (generic) |
| delete_folder | write | DELETE workspaces/{ws}/folders/{folderId} | `aihub fabric api delete_folder` | ported (generic) |
| list_tags | read | GET tags | `aihub fabric api list_tags` | ported (generic) |
| apply_tags | write | POST workspaces/{ws}/items/{item}/applyTags | `aihub fabric api apply_tags` | ported (generic) with --body-file |
| unapply_tags | write | POST workspaces/{ws}/items/{item}/unapplyTags | `aihub fabric api unapply_tags` | ported (generic) with --body-file |
| get_git_connection | read | GET workspaces/{ws}/git/connection | `aihub fabric api get_git_connection` | ported (generic) |
| get_git_status | read | GET workspaces/{ws}/git/status | `aihub fabric git status` (also `api get_git_status`) | ported |
| get_my_git_credentials | read | GET workspaces/{ws}/git/myGitCredentials | `aihub fabric api get_my_git_credentials` | ported (generic) |
| connect_git | write | POST workspaces/{ws}/git/connect | `aihub fabric api connect_git` | ported (generic) with --body-file |
| disconnect_git | write | POST workspaces/{ws}/git/disconnect | `aihub fabric api disconnect_git` | ported (generic) |
| initialize_git_connection | write | POST workspaces/{ws}/git/initializeConnection | `aihub fabric api initialize_git_connection` | ported (generic) |
| commit_to_git | write | POST workspaces/{ws}/git/commitToGit | `aihub fabric git commit --message-file` (also `api commit_to_git`) | ported |
| update_from_git | write | POST workspaces/{ws}/git/updateFromGit | `aihub fabric git update` (also `api update_from_git`) | ported |
| update_my_git_credentials | write | PATCH workspaces/{ws}/git/myGitCredentials | `aihub fabric api update_my_git_credentials` | ported (generic) with --body-file |
| list_deployment_pipelines | read | GET deploymentPipelines | `aihub fabric deployment list` (also `api list_deployment_pipelines`) | ported |
| get_deployment_pipeline | read | custom handler | `aihub fabric deployment stages` (also `api get_deployment_pipeline`) | ported |
| list_deployment_stage_items | read | custom handler | `aihub fabric api list_deployment_stage_items` (also `api list_deployment_stage_items`) | ported |
| list_deployment_operations | read | custom handler | `aihub fabric api list_deployment_operations` (also `api list_deployment_operations`) | ported |
| deploy_stage | write | custom handler | `aihub fabric deployment deploy` | ported |
| plan_job | read | custom handler | `aihub fabric run --dry-run` | ported |
| run_job | write | custom handler | `aihub fabric run` | ported |
| run_pipeline | write | custom handler | `aihub fabric run` | ported |
| run_notebook | write | custom handler | `aihub fabric run [--params-file]` | ported |
| run_table_maintenance | write | custom handler | `aihub fabric lakehouse maintenance` | ported |
| cancel_job | write | POST workspaces/{ws}/items/{item}/jobs/instances/{runId}/cancel | `aihub fabric job cancel / run --cancel` (also `api cancel_job`) | ported |
| invoke_udf | write | custom handler | `aihub fabric udf invoke` | ported |
| livy_run | write | custom handler | `aihub fabric livy run` | ported |
| list_schedules | read | GET workspaces/{ws}/items/{item}/jobs/{jobType}/schedules | `aihub fabric schedules` (also `api list_schedules`) | ported |
| create_schedule | write | POST workspaces/{ws}/items/{item}/jobs/{jobType}/schedules | `aihub fabric api create_schedule` | ported (generic) with --body-file |
| update_schedule | write | PATCH workspaces/{ws}/items/{item}/jobs/{jobType}/schedules/{scheduleId} | `aihub fabric api update_schedule` | ported (generic) with --body-file |
| delete_schedule | write | DELETE workspaces/{ws}/items/{item}/jobs/{jobType}/schedules/{scheduleId} | `aihub fabric api delete_schedule` | ported (generic) |
| list_runs | read | custom handler | `aihub fabric jobs` | ported |
| get_run | read | custom handler | `aihub fabric status / job show` | ported |
| get_logs | read | custom handler | `aihub fabric logs --item I --job ID; spark logs (driver, executor, Livy; --tail --search --errors --cell)` | ported |
| get_failure | read | custom handler | `aihub fabric failures` | ported |
| link_pipeline_run | read | custom handler | `aihub fabric failures (follows pipeline -> child pipeline -> notebook -> Spark)` | ported |
| prepare_repair | read | custom handler | - | dropped: IDE-only repair chat; the agent reads `failures` and edits the files itself |
| get_activity_runs | read | custom handler | `aihub fabric logs --item PIPE --job ID` | ported |
| get_operation | read | custom handler | `aihub fabric api get_operation` (also `api get_operation`) | ported |
| get_operation_result | read | custom handler | `aihub fabric api get_operation_result` (also `api get_operation_result`) | ported |
| list_spark_sessions | read | custom handler | `aihub fabric spark sessions` (also `api list_spark_sessions`) | ported |
| get_spark_monitoring | read | custom handler | `aihub fabric spark app --view application|jobs|stages|tasks|executors|sql|environment|advice|resourceUsage` | ported |
| prepare_notebook_test | write | custom handler | `aihub fabric notebook-test prepare` | ported |
| run_notebook_test | write | custom handler | `aihub fabric notebook-test run` | ported |
| verify_notebook_test | read | custom handler | `aihub fabric notebook-test verify` | ported |
| onelake_list | read | custom handler | `aihub fabric onelake list / lakehouse files` | ported |
| onelake_read | read | custom handler | `aihub fabric onelake read` | ported |
| onelake_write | write | custom handler | `aihub fabric onelake write` | ported |
| onelake_mkdir | write | custom handler | `aihub fabric onelake mkdir` | ported |
| onelake_delete | write | custom handler | `aihub fabric onelake delete --yes` | ported |
| onelake_move | write | custom handler | `aihub fabric onelake move --to` | ported |
| list_lakehouse_tables | read | GET workspaces/{ws}/lakehouses/{item}/tables?maxResults=100 | `aihub fabric lakehouse tables` (also `api list_lakehouse_tables`) | ported |
| load_table | write | POST workspaces/{ws}/lakehouses/{item}/tables/{tableName}/load | `aihub fabric lakehouse load` (also `api load_table`) | ported |
| refresh_sql_endpoint | write | POST workspaces/{ws}/sqlEndpoints/{sqlEndpointId}/refreshMetadata | `aihub fabric api refresh_sql_endpoint` | ported (generic) with --body-file |
| get_storage_properties | read | custom handler | `aihub fabric api get_lakehouse / get_warehouse / get_mirrored_database` | ported |
| list_shortcuts | read | GET workspaces/{ws}/items/{item}/shortcuts | `aihub fabric shortcuts` (also `api list_shortcuts`) | ported |
| get_shortcut | read | GET workspaces/{ws}/items/{item}/shortcuts/{path}/{shortcutName} | `aihub fabric api get_shortcut` | ported (generic) |
| create_shortcut | write | POST workspaces/{ws}/items/{item}/shortcuts | `aihub fabric api create_shortcut` | ported (generic) with --body-file |
| delete_shortcut | write | DELETE workspaces/{ws}/items/{item}/shortcuts/{path}/{shortcutName} | `aihub fabric api delete_shortcut` | ported (generic) |
| list_data_access_roles | read | GET workspaces/{ws}/items/{item}/dataAccessRoles | `aihub fabric api list_data_access_roles` | ported (generic) |
| set_data_access_roles | write | PUT workspaces/{ws}/items/{item}/dataAccessRoles | `aihub fabric api set_data_access_roles` | ported (generic) with --body-file |
| list_data_shares | read | GET workspaces/{ws}/items/{item}/externalDataShares | `aihub fabric api list_data_shares` | ported (generic) |
| create_data_share | write | POST workspaces/{ws}/items/{item}/externalDataShares | `aihub fabric api create_data_share` | ported (generic) with --body-file |
| revoke_data_share | write | POST workspaces/{ws}/items/{item}/externalDataShares/{shareId}/revoke | `aihub fabric api revoke_data_share` | ported (generic) |
| sql_query | read | custom handler | `aihub fabric sql` | ported |
| query_kql | read | custom handler | `aihub fabric kql` | ported |
| execute_dax | read | custom handler | `aihub fabric dax` | ported |
| query_graphql | read | custom handler | `aihub fabric graphql` | ported |
| get_refresh_history | read | custom handler | `aihub fabric logs --item MODEL` | ported |
| refresh_semantic_model | write | POST powerbi:groups/{ws}/datasets/{item}/refreshes | `aihub fabric api refresh_semantic_model` | ported (generic) with --body-file |
| get_environment | read | custom handler | `aihub fabric environment libraries; api get_environment` (also `api get_environment`) | ported |
| upload_environment_library | write | custom handler | `aihub fabric environment upload-library` | ported |
| delete_environment_library | write | DELETE workspaces/{ws}/environments/{item}/staging/libraries/{library} | `aihub fabric api delete_environment_library` | ported (generic) |
| update_environment_spark_compute | write | PATCH workspaces/{ws}/environments/{item}/staging/sparkcompute?beta=false | `aihub fabric api update_environment_spark_compute` | ported (generic) with --body-file |
| publish_environment | write | custom handler | `aihub fabric environment publish` | ported |
| get_spark_settings | read | custom handler | `aihub fabric api get_spark_settings` | ported (generic) |
| update_spark_settings | write | PATCH workspaces/{ws}/spark/settings | `aihub fabric api update_spark_settings` | ported (generic) with --body-file |
| save_custom_pool | write | custom handler | `aihub fabric api save_custom_pool` (also `api save_custom_pool`) | ported |
| get_mirroring_status | read | custom handler | `aihub fabric api get_mirroring_status` | ported (generic) |
| set_mirroring | write | POST workspaces/{ws}/mirroredDatabases/{item}/{action}Mirroring | `aihub fabric api set_mirroring` | ported (generic) |
| get_variable_library | read | custom handler | `aihub fabric api get_variable_library` | ported (generic) |
| set_active_value_set | write | PATCH workspaces/{ws}/variableLibraries/{item} | `aihub fabric api set_active_value_set` | ported (generic) with --body-file |
| get_eventstream | read | custom handler | `aihub fabric api get_eventstream / get_eventstream_topology` (also `api get_eventstream`) | ported |
| set_eventstream_state | write | custom handler | `aihub fabric api set_eventstream_state (also _source_state, _destination_state)` (also `api set_eventstream_state`) | ported |
| discover_databricks_catalog | read | custom handler | `aihub fabric api discover_databricks_catalog (_schemas, _tables)` (also `api discover_databricks_catalog`) | ported |
| get_ml_model_endpoint | read | custom handler | `aihub fabric api get_ml_model_endpoint (+ _versions)` (also `api get_ml_model_endpoint`) | ported |
| list_connections | read | GET connections | `aihub fabric connections` (also `api list_connections`) | ported |
| get_connection | read | GET connections/{connectionId} | `aihub fabric api get_connection` | ported (generic) |
| list_connection_types | read | GET connections/supportedConnectionTypes | `aihub fabric api list_connection_types` | ported (generic) |
| create_connection | write | custom handler | `aihub fabric connection create --body-file (secrets as kv://)` | ported |
| update_connection | write | custom handler | `aihub fabric connection update --body-file` | ported |
| delete_connection | write | custom handler | `aihub fabric connection delete --confirm-name` | ported |
| list_connection_role_assignments | read | GET connections/{connectionId}/roleAssignments | `aihub fabric api list_connection_role_assignments` | ported (generic) |
| add_connection_role_assignment | write | POST connections/{connectionId}/roleAssignments | `aihub fabric api add_connection_role_assignment` | ported (generic) with --body-file |
| delete_connection_role_assignment | write | DELETE connections/{connectionId}/roleAssignments/{roleAssignmentId} | `aihub fabric api delete_connection_role_assignment` | ported (generic) |
| dbt_detect | write | Kotlin tool (local dbt CLI and Fabric REST) | `aihub fabric dbt detect` | ported |
| dbt_get_run_results | write | Kotlin tool (local dbt CLI and Fabric REST) | `aihub fabric dbt results` | ported |
| dbt_get_job | write | Kotlin tool (local dbt CLI and Fabric REST) | `aihub fabric dbt get-job` | ported |
| dbt_scaffold | write | Kotlin tool (local dbt CLI and Fabric REST) | `aihub fabric dbt scaffold` | ported |
| dbt_run | write | Kotlin tool (local dbt CLI and Fabric REST) | `aihub fabric dbt run` | ported |
| dbt_upload_project | write | Kotlin tool (local dbt CLI and Fabric REST) | `aihub fabric dbt upload` | ported |
| dbt_save_job | write | Kotlin tool (local dbt CLI and Fabric REST) | `aihub fabric dbt save-job` | ported |
| dbt_guide | read | Kotlin knowledge base | - | dropped: static knowledge base; it belongs in a skill, not in the CLI |
