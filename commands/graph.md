---
description: "Code graph (graphify): answer or offer to build"
---
GRAPH: $ARGUMENTS
1. graphify-out/graph.json exists? -> graphify query "<question>" (--budget 1000), --dfs to trace, graphify path for links, graphify explain for a node.
2. No graph? Propose: graphify . --no-viz (+ --wiki for agent crawling). Ask user first (expensive).
3. Answer concise: conclusion + file refs, not dumps.
