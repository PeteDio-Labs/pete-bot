import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { Logger, LogLevel } from './logger.js';

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Pino writes to stdout/stderr, not console.log/warn/error
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  function getLogMessages(spy: ReturnType<typeof vi.spyOn>): Array<{ level: number; msg: string; args?: unknown[] }> {
    return spy.mock.calls
      .map((call: unknown[]) => {
        const output = call[0]?.toString();
        if (!output) return null;
        try {
          return JSON.parse(output);
        } catch {
          return null;
        }
      })
      .filter((log: unknown): log is { level: number; msg: string; args?: unknown[] } => log !== null);
  }

  describe('Log level filtering', () => {
    it('should log all levels when set to DEBUG', () => {
      const logger = new Logger(LogLevel.DEBUG, false);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThanOrEqual(4);
      
      const messages = logs.map(l => l.msg);
      expect(messages).toContain('debug message');
      expect(messages).toContain('info message');
      expect(messages).toContain('warn message');
      expect(messages).toContain('error message');
    });

    it('should only log info and above when set to INFO', () => {
      const logger = new Logger(LogLevel.INFO, false);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      const logs = getLogMessages(stdoutSpy);
      const messages = logs.map(l => l.msg);
      
      expect(messages).not.toContain('debug message');
      expect(messages).toContain('info message');
      expect(messages).toContain('warn message');
      expect(messages).toContain('error message');
    });

    it('should only log warn and above when set to WARN', () => {
      const logger = new Logger(LogLevel.WARN, false);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      const logs = getLogMessages(stdoutSpy);
      const messages = logs.map(l => l.msg);
      
      expect(messages).not.toContain('debug message');
      expect(messages).not.toContain('info message');
      expect(messages).toContain('warn message');
      expect(messages).toContain('error message');
    });

    it('should only log errors when set to ERROR', () => {
      const logger = new Logger(LogLevel.ERROR, false);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      const logs = getLogMessages(stdoutSpy);
      const messages = logs.map(l => l.msg);
      
      expect(messages).not.toContain('debug message');
      expect(messages).not.toContain('info message');
      expect(messages).not.toContain('warn message');
      expect(messages).toContain('error message');
    });

    it('should log nothing when set to SILENT', () => {
      const logger = new Logger(LogLevel.SILENT, false);

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBe(0);
    });
  });

  describe('Timestamps', () => {
    it('should include timestamps in JSON output', () => {
      const logger = new Logger(LogLevel.DEBUG, true);
      logger.info('test message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toHaveProperty('time');
    });

    it('should include timestamps even when timestamps=false (Pino always includes time)', () => {
      const logger = new Logger(LogLevel.DEBUG, false);
      logger.info('test message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      // Pino always includes time field, timestamps param is ignored for compatibility
      expect(logs[0]).toHaveProperty('time');
    });
  });

  describe('Prefix', () => {
    it('should include name in log messages', () => {
      const logger = new Logger(LogLevel.DEBUG, false, 'TestModule');
      logger.info('test message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toHaveProperty('name', 'TestModule');
      expect(logs[0]?.msg).toBe('test message');
    });

    it('should not include name when empty', () => {
      const logger = new Logger(LogLevel.DEBUG, false, '');
      logger.info('test message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).not.toHaveProperty('name');
      expect(logs[0]?.msg).toBe('test message');
    });
  });

  describe('Child logger', () => {
    it('should create child logger with name', () => {
      const parent = new Logger(LogLevel.DEBUG, false, 'Parent');
      const child = parent.child('Child');

      child.info('test message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toHaveProperty('name', 'Child');
      expect(logs[0]?.msg).toBe('test message');
    });

    it('should create child logger with just the child name when parent has no prefix', () => {
      const parent = new Logger(LogLevel.DEBUG, false);
      const child = parent.child('Child');

      child.info('test message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toHaveProperty('name', 'Child');
      expect(logs[0]?.msg).toBe('test message');
    });

    it('should inherit log level from parent', () => {
      const parent = new Logger(LogLevel.WARN, false);
      const child = parent.child('Child');

      child.debug('debug message');
      child.info('info message');
      child.warn('warn message');

      const logs = getLogMessages(stdoutSpy);
      const messages = logs.map(l => l.msg);
      
      expect(messages).not.toContain('debug message');
      expect(messages).not.toContain('info message');
      expect(messages).toContain('warn message');
    });

    it('should inherit timestamp setting from parent', () => {
      const parent = new Logger(LogLevel.DEBUG, true);
      const child = parent.child('Child');

      child.info('test message');

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toHaveProperty('time');
    });
  });

  describe('raw()', () => {
    it('should always print regardless of log level', () => {
      const logger = new Logger(LogLevel.SILENT, false);

      logger.raw('raw message');

      expect(consoleSpy).toHaveBeenCalledWith('raw message');
    });

    it('should not format raw messages', () => {
      const logger = new Logger(LogLevel.DEBUG, true, 'Prefix');

      logger.raw('raw message');

      expect(consoleSpy).toHaveBeenCalledWith('raw message');
    });
  });

  describe('Additional arguments', () => {
    it('should include additional arguments in args field', () => {
      const logger = new Logger(LogLevel.DEBUG, false);
      const extraData = { key: 'value' };

      logger.info('test message', extraData);

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]?.msg).toBe('test message');
      expect(logs[0]).toHaveProperty('args');
      expect(logs[0]?.args).toEqual([extraData]);
    });

    it('should pass multiple additional arguments in args array', () => {
      const logger = new Logger(LogLevel.DEBUG, false);

      logger.error('error message', 'arg1', 123, { foo: 'bar' });

      const logs = getLogMessages(stdoutSpy);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]?.msg).toBe('error message');
      expect(logs[0]?.args).toEqual(['arg1', 123, { foo: 'bar' }]);
    });
  });

  describe('getLevel()', () => {
    it('should return the configured log level', () => {
      const logger = new Logger(LogLevel.WARN, false);

      expect(logger.getLevel()).toBe(LogLevel.WARN);
    });
  });
});
