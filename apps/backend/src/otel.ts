/**
 * OpenTelemetry bootstrap (design doc 17 §11), loaded before the app with
 * `node --import ./dist/otel.js`. Traces and metrics go over OTLP/HTTP to
 * OTEL_EXPORTER_OTLP_ENDPOINT (e.g. Seq); without it nothing starts.
 */
import { register } from 'node:module';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  // ESM modules are patched through import-in-the-middle's loader hook.
  register('import-in-the-middle/hook.mjs', import.meta.url);
  const base = endpoint.replace(/\/$/, '');
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'crewhall-backend',
      [ATTR_SERVICE_VERSION]: process.env.CREWHALL_VERSION ?? '0.0.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis: 30_000,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url === '/healthz' || req.url === '/readyz',
      }),
      new PgInstrumentation(),
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  const stop = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
