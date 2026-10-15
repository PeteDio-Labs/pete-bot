import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { startMetricsServer, stopMetricsServer, getMetricsApp } from './server.js';
import { discordBotUp } from './index.js';

describe('Metrics Server', () => {
  describe('HTTP endpoints', () => {
    const app = getMetricsApp();

    it('should respond to /metrics endpoint with Prometheus format', async () => {
      const response = await request(app).get('/metrics');
      
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('# HELP');
      expect(response.text).toContain('# TYPE');
    });

    it('should include metric values in /metrics response', async () => {
      discordBotUp.set(1);
      const response = await request(app).get('/metrics');
      
      expect(response.status).toBe(200);
      expect(response.text).toContain('discord_bot_up');
    });

    it('should respond to /health endpoint', async () => {
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });

    it('should return 404 for unknown endpoints', async () => {
      const response = await request(app).get('/unknown');
      
      expect(response.status).toBe(404);
    });
  });

  describe('Server lifecycle', () => {
    it('should start server on specified port', async () => {
      const server = await startMetricsServer(9091);
      expect(server).toBeDefined();
      
      // Test that server is listening
      const response = await request(`http://localhost:9091`).get('/health');
      expect(response.status).toBe(200);
      
      await stopMetricsServer();
    });

    it('should stop server cleanly', async () => {
      await startMetricsServer(9092);
      await stopMetricsServer();
      
      // Server should be stopped, so the request fails or times out
      const reached = await request(`http://localhost:9092`)
        .get('/health')
        .timeout(100)
        .then(
          () => true,
          () => false,
        );
      expect(reached).toBe(false);
    });
  });
});
