const STATUS_API_URL = "/api/actions/status";
const POLL_INTERVAL = 3000;

const message = document.getElementById("update-message");
const state = document.getElementById("update-state");
const backButton = document.getElementById("back-button");

async function checkUpdateStatus() {
  try {
    const response = await fetch(STATUS_API_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (data.status === "completed") {
      state.textContent = "Обновление завершено";
      window.location.href = "/";
      return;
    }

    if (data.status === "error") {
      state.textContent = "Ошибка обновления";
      message.textContent = data.message || "Не удалось завершить обновление.";
      document.querySelector(".spinner").hidden = true;
      backButton.hidden = false;
      return;
    }

    state.textContent = data.status === "running" ? "Обновление выполняется" : "Ожидание запуска";
  } catch (error) {
    console.error("Update status error:", error);
    state.textContent = "Ожидание доступности сервиса";
  }

  window.setTimeout(checkUpdateStatus, POLL_INTERVAL);
}

checkUpdateStatus();
