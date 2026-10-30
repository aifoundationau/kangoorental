import { Router } from 'express';
import { getSettings, num } from '../db.js';
import { currentRate } from '../fx.js';

export const router = Router();

// Weather comes from Open-Meteo (free, no key) for the pickup location, cached for 10 minutes.
let weatherCache = { at: 0, key: '', data: null };

const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail',
  99: 'Severe thunderstorm with hail',
};

router.get('/hub', async (req, res) => {
  const settings = await getSettings();
  const lat = num(settings, 'pickup_lat');
  const lng = num(settings, 'pickup_lng');
  const key = `${lat},${lng}`;

  if (Date.now() - weatherCache.at > 10 * 60 * 1000 || weatherCache.key !== key) {
    try {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude: lat, longitude: lng, timezone: 'Australia/Brisbane', forecast_days: '4',
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset',
      }).toString();
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const d = await r.json();
        weatherCache = {
          at: Date.now(),
          key,
          data: {
            current: {
              temperature: d.current.temperature_2m,
              feelsLike: d.current.apparent_temperature,
              humidity: d.current.relative_humidity_2m,
              windKmh: d.current.wind_speed_10m,
              precipitationMm: d.current.precipitation,
              summary: WEATHER_CODES[d.current.weather_code] || 'Mixed conditions',
              code: d.current.weather_code,
            },
            daily: d.daily.time.map((date, i) => ({
              date,
              max: d.daily.temperature_2m_max[i],
              min: d.daily.temperature_2m_min[i],
              rainChance: d.daily.precipitation_probability_max[i],
              uv: d.daily.uv_index_max[i],
              sunrise: d.daily.sunrise[i],
              sunset: d.daily.sunset[i],
              summary: WEATHER_CODES[d.daily.weather_code[i]] || 'Mixed conditions',
              code: d.daily.weather_code[i],
            })),
          },
        };
      }
    } catch (err) {
      console.warn('[hub] weather fetch failed:', err.message);
    }
  }

  res.json({
    pickup: { label: settings.pickup_label, lat, lng },
    timezone: 'Australia/Brisbane',
    weather: weatherCache.data,
    fx: currentRate(settings),
  });
});
