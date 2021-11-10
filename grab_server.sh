
# Helper script for pulling AdeptInsightNodeJS

# Configuration
# ---------------------------------------------------------------------------
APEPT_INSIGHT_NODE_JS_ROOT=~/Projects/AdeptInsightNodeJS
# ---------------------------------------------------------------------------

cp $APEPT_INSIGHT_NODE_JS_ROOT/bin/insight_server.js server/out/insight_server.js
cp $APEPT_INSIGHT_NODE_JS_ROOT/bin/insight_server.wasm server/out/insight_server.wasm
cat server/src/insight_server_postfix.js >> server/out/insight_server.js
