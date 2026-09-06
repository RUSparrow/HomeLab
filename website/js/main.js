document.addEventListener("DOMContentLoaded", () => {
  const header = document.getElementById("header");
  const navToggle = document.getElementById("nav-toggle");
  const navMenu = document.getElementById("nav-menu");
  const navLinks = document.querySelectorAll(".nav__link");
  const contactForm = document.getElementById("contact-form");
  const toast = document.getElementById("toast");
  const yearEl = document.getElementById("year");

  yearEl.textContent = new Date().getFullYear();

  /* Scroll: header shadow */
  window.addEventListener("scroll", () => {
    header.classList.toggle("header--scrolled", window.scrollY > 20);
  });

  /* Mobile menu */
  navToggle.addEventListener("click", () => {
    navToggle.classList.toggle("nav__toggle--open");
    navMenu.classList.toggle("nav__menu--open");
  });

  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      navToggle.classList.remove("nav__toggle--open");
      navMenu.classList.remove("nav__menu--open");
    });
  });

  /* Active nav link on scroll */
  const sections = document.querySelectorAll("section[id]");

  const setActiveLink = () => {
    const scrollPos = window.scrollY + 100;

    sections.forEach((section) => {
      const top = section.offsetTop;
      const height = section.offsetHeight;
      const id = section.getAttribute("id");

      if (scrollPos >= top && scrollPos < top + height) {
        navLinks.forEach((link) => {
          link.classList.toggle("nav__link--active", link.getAttribute("href") === `#${id}`);
        });
      }
    });
  };

  window.addEventListener("scroll", setActiveLink);
  setActiveLink();

  /* Fade-in on scroll */
  const fadeElements = document.querySelectorAll(
    ".section__title, .about__text, .about__facts, .skill-card, .contact__form, .contact__links"
  );

  fadeElements.forEach((el) => el.classList.add("fade-in"));

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("fade-in--visible");
        }
      });
    },
    { threshold: 0.15 }
  );

  fadeElements.forEach((el) => observer.observe(el));

  /* Form validation */
  const validators = {
    name: (value) => (value.trim().length < 2 ? "Введите имя (минимум 2 символа)" : ""),
    email: (value) => {
      const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return pattern.test(value.trim()) ? "" : "Введите корректный email";
    },
    message: (value) => (value.trim().length < 10 ? "Сообщение должно быть не короче 10 символов" : ""),
  };

  const showError = (field, message) => {
    const input = document.getElementById(field);
    const errorEl = document.getElementById(`${field}-error`);
    input.classList.toggle("form__input--error", Boolean(message));
    errorEl.textContent = message;
  };

  const validateField = (field) => {
    const input = document.getElementById(field);
    const error = validators[field](input.value);
    showError(field, error);
    return !error;
  };

  ["name", "email", "message"].forEach((field) => {
    document.getElementById(field).addEventListener("blur", () => validateField(field));
  });

  contactForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const isValid = ["name", "email", "message"].every(validateField);
    if (!isValid) return;

    showToast("Сообщение отправлено! Спасибо за обращение.", "success");
    contactForm.reset();
    ["name", "email", "message"].forEach((field) => showError(field, ""));
  });

  /* Toast notification */
  let toastTimeout;

  function showToast(message, type = "") {
    toast.textContent = message;
    toast.className = "toast";
    if (type) toast.classList.add(`toast--${type}`);

    requestAnimationFrame(() => toast.classList.add("toast--visible"));

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove("toast--visible");
    }, 3500);
  }
});
