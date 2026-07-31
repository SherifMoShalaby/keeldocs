create table raw_numbers (n integer not null);
create view evens as select n from raw_numbers where n % 2 = 0;
create materialized view evens_mat as select n from raw_numbers where n % 2 = 0;
