# Embedding Model Evaluation Notes

Working notes from evaluating embedding models for the in-product semantic
search feature (help-center articles + community posts, ~400k documents).

## Candidates

We shortlisted four: a 384-dim MiniLM-class model, a 768-dim BERT-base-class
model, a long-context 8k-token model, and a hosted API model as the quality
ceiling reference. Everything self-hosted ran as ONNX on CPU inference nodes.

## Retrieval quality

On our internal golden set (1,200 query-document pairs labeled by support
staff), the 768-dim model beat the 384-dim model by 4.1 points of nDCG@10.
The hosted API model added only 1.9 more points — not worth the per-query
cost and the data-egress review. Long-context helped only on the community
posts corpus, where threads run long; help-center articles never exceeded
1,500 tokens.

## Latency and cost

The 384-dim model embeds a query in 9ms on one CPU core; the 768-dim model
takes 21ms. At our 40 QPS peak that's the difference between 2 and 5
inference nodes. Index memory matters more: 400k docs × 768 dims × fp32 is
1.2GB versus 600MB at 384 dims, before any HNSW graph overhead.

## Quantization experiments

### Scalar int8

Post-training scalar quantization of the 768-dim vectors to int8 cost 0.4
nDCG points and cut index memory 4x. Effectively free — adopted without
debate.

### Binary quantization

The aggressive experiment: 1 bit per dimension with Hamming-distance
retrieval, then rescoring the top 200 candidates with the full-precision
vectors. Recall@10 against the full-precision baseline came out at 96.1%
on help-center queries and 92.7% on community-post queries — the rescoring
step is what saves it; raw binary retrieval without rescore was at 81%.
Index memory drops 32x, and Hamming distance over packed bits is absurdly
fast with SIMD. We are adopting binary + rescore for the community corpus
where index size dominates, and keeping int8 for help-center where the
corpus is small enough not to care.

## Decision

768-dim model, int8 for help-center, binary-with-rescore for community.
Revisit when the corpus passes 2M documents or if query latency budgets
tighten below 50ms end-to-end.
