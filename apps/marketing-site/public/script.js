// Mobile nav toggle
const navToggle = document.getElementById("navToggle");
if (navToggle) {
  navToggle.addEventListener("click", () => {
    document.body.classList.toggle("nav-open");
  });
}

// Click-to-play for any ready video card (placeholder cards have no <video>, so this is a no-op for them)
document.querySelectorAll(".video-card[data-status='ready']").forEach((card) => {
  const media = card.querySelector(".video-card-media");
  const video = card.querySelector("video");
  const playBtn = card.querySelector(".play-btn");
  if (!media || !video || !playBtn) return;

  media.addEventListener("click", () => {
    if (video.paused) {
      video.muted = false;
      video.play();
      playBtn.style.display = "none";
    } else {
      video.pause();
      playBtn.style.display = "flex";
    }
  });

  video.addEventListener("ended", () => {
    playBtn.style.display = "flex";
  });
});

// Email capture stub — no backend wired yet, just confirms the intent locally
const emailForm = document.getElementById("emailForm");
const emailNote = document.getElementById("emailNote");
if (emailForm) {
  emailForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = new FormData(emailForm).get("email");
    emailNote.textContent = `Thanks — we'll reach out to ${email} when your first cycle is ready.`;
    emailForm.reset();
  });
}
