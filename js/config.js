window.SMARTPORT_CONFIG = {
  version: "0.6.0",
  projectRepository: "smartport-ntume/SmartPort-Project-Control",
  apiBase: "https://smartport-progress-hub-api.zf20000302.workers.dev",
  endpoints: {
    health: "/api/health",
    me: "/api/me",
    login: "/auth/login",
    logout: "/auth/logout",
    snapshot: "/api/project/snapshot",
    workPackages: "/api/project/work-packages",
    subtasks: "/api/project/subtasks",
    fsr: "/api/safety/fsr",
    checkpoints: "/api/project/checkpoints"
  }
};
