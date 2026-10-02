import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } }),
    ],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
