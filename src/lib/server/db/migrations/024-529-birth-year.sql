-- #14: 529 beneficiaries store a birth year, not a bare "age today". A static
-- age silently pushes the college year out by one every calendar year; a birth
-- year keeps the projection anchored to the child. Convert each existing age
-- using the current year at migration time (age was entered ~now).
-- 'localtime' matches localToday() (the app's local-tz calendar), so the year
-- can't drift on the UTC/local new-year boundary.
INSERT INTO settings (key, value)
SELECT replace(key, '_age', '_birth_year'),
       CAST(CAST(strftime('%Y', 'now', 'localtime') AS INTEGER) - CAST(value AS INTEGER) AS TEXT)
FROM settings
WHERE key GLOB '529_*_age';

DELETE FROM settings WHERE key GLOB '529_*_age';
