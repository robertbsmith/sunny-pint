/**
 * Type declarations for modules that don't ship their own.
 */

declare module "suncalc" {
  export interface SunPosition {
    azimuth: number;
    altitude: number;
  }

  export interface SunTimes {
    sunrise: Date;
    sunriseEnd: Date;
    goldenHourEnd: Date;
    solarNoon: Date;
    goldenHour: Date;
    sunsetStart: Date;
    sunset: Date;
    dusk: Date;
    nauticalDusk: Date;
    night: Date;
    nadir: Date;
    nightEnd: Date;
    nauticalDawn: Date;
    dawn: Date;
  }

  export function getPosition(date: Date, lat: number, lng: number): SunPosition;
  export function getTimes(date: Date, lat: number, lng: number): SunTimes;

  const _default: {
    getPosition: typeof getPosition;
    getTimes: typeof getTimes;
  };
  export default _default;
}

declare module "*.css";
