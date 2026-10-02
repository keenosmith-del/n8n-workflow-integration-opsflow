#!/bin/sh
set -eu
# Provision before server startup: CLI database changes need a fresh n8n process.
node -e 'require("fs").writeFileSync("/tmp/opsflow-credentials.json", JSON.stringify([{id:"opsflow-webhook-auth",name:"OpsFlow webhook authentication",type:"httpHeaderAuth",data:{name:"x-workflow-token",value:process.env.WORKFLOW_TOKEN}}]))'
n8n import:credentials --input=/tmp/opsflow-credentials.json
rm /tmp/opsflow-credentials.json
n8n import:workflow --separate --input=/workflows
n8n publish:workflow --id=opsflow-collect-v1
n8n publish:workflow --id=opsflow-finalize-v1
exec n8n start
