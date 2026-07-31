create index posts_author_idx on posts(author_id);
alter table posts add column published boolean not null default false;
