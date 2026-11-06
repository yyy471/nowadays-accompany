(() => {
  "use strict";

  const seasons = ["winter", "winter", "spring", "spring", "spring", "summer",
    "summer", "summer", "autumn", "autumn", "autumn", "winter"];
  const daylight = { spring: [6, 18.5], summer: [5.5, 19.5], autumn: [6.5, 18], winter: [7, 17] };
  const weatherBySeason = {
    spring: ["clear", "cloud", "clear", "rain"],
    summer: ["clear", "clear", "cloud", "rain"],
    autumn: ["clear", "cloud", "clear", "rain"],
    winter: ["clear", "cloud", "snow", "cloud"]
  };
  const phaseHours = { dawn: 0, day: 1, dusk: 2, night: 3 };

  function resolveEnvironment(now, settings) {
    const season = settings.season === "auto" ? seasons[now.getMonth()] : settings.season;
    const hour = now.getHours() + now.getMinutes() / 60;
    const [sunrise, sunset] = daylight[season];
    const phases = ["night", "night", "dawn", "day", "day", "dusk", "night", "night"];
    const hours = [0, sunrise - .85, sunrise, sunrise + 1.5, sunset - 1.5, sunset, sunset + 1.1, 24];
    const end = hours.findIndex((boundary, i) => i > 0 && hour < boundary);
    const timeMix = (hour - hours[end - 1]) / (hours[end] - hours[end - 1]);
    const from = settings.time === "auto" ? phases[end - 1] : settings.time;
    const to = settings.time === "auto" ? phases[end] : from;
    const mix = from === to ? 0 : timeMix * timeMix * (3 - 2 * timeMix);
    const phase = mix < .5 ? from : to;
    const choices = weatherBySeason[season];
    const weather = settings.weather === "auto"
      ? choices[(now.getDate() + now.getMonth() * 11 + Math.floor(hour / 6)) % choices.length]
      : settings.weather;
    const lamp = settings.lamp ?? (phaseHours[phase] >= phaseHours.dusk);
    const suffix = lamp ? "-on" : "-off";
    const weatherPlate = name => {
      if (weather === "clear") return name;
      if (weather === "snow") return name === "night" ? "snow-night" : "snow";
      if (name === "night") return "wet-night";
      return weather === "rain" ? "rain" : "cloud";
    };
    return { season, weather, lamp, phase, from, to, mix,
      base: weatherPlate(from) + suffix, next: weatherPlate(to) + suffix };
  }

  globalThis.deskEnvironment = { resolveEnvironment };
})();
