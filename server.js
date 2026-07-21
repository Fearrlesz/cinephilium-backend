import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import './App.css';

// ===== КОНСТАНТЫ =====
const baseNames = [
  '🎭 Сценарий и драматургия',
  '🎨 Режиссура и визуал',
  '🔊 Звук и аудио-атмосфера',
  '🎬 Актерская игра и монтаж'
];

const criteriaNames = [
  ['Оригинальность сюжета', 'Логичность событий', 'Качество диалогов', 'Умение создавать напряжение', 'Сильная концовка'],
  ['Композиция кадра', 'Цветокоррекция', 'Мастерство освещения', 'Движение камеры', 'Визуальные метафоры'],
  ['Качество саундтрека', 'Звуковой дизайн', 'Использование тишины', 'Разборчивость речи', 'Естественность звуков'],
  ['Аутентичность актеров', 'Химия между актёрами', 'Богатство мимики', 'Ритм монтажа', 'Техническая чистота']
];

const baseDescriptions = [
  ['Насколько оригинален сюжет?', 'Нет ли сюжетных дыр?', 'Насколько естественно звучат диалоги?', 'Умеет ли фильм держать в напряжении?', 'Удовлетворяет ли концовка?'],
  ['Насколько гармонична композиция кадра?', 'Соответствует ли цветокоррекция настроению?', 'Насколько профессионально освещение?', 'Уместна ли работа камеры?', 'Есть ли визуальные метафоры?'],
  ['Насколько хорош саундтрек?', 'Насколько качественно звуковое окружение?', 'Насколько уместна тишина?', 'Четко ли слышна речь?', 'Насколько естественны звуковые эффекты?'],
  ['Верите ли вы актёрам?', 'Чувствуете ли химию между актёрами?', 'Насколько выразительна мимика?', 'Соответствует ли монтаж динамике?', 'Насколько чисто сделаны склейки?']
];

// ===== API =====
const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:3000/api',
});

api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ===== УТИЛИТЫ =====
function getScoreColor(score) {
  if (score === undefined || score === null || isNaN(score)) return '#666';
  const clampedScore = Math.max(6, Math.min(90, score));
  const normalized = (clampedScore - 6) / 84;
  const hue = normalized * 120;
  return `hsl(${hue}, 85%, ${45 + normalized * 15}%)`;
}

// ===== МОДАЛЬНОЕ ОКНО С ДЕТАЛЯМИ ОЦЕНКИ =====
function RatingDetailsModal({ rating, onClose }) {
  if (!rating) return null;

  const bases = [rating.base1, rating.base2, rating.base3, rating.base4];
  const baseAverages = bases.map(base => 
    base && base.length === 5 ? (base.reduce((a, b) => a + b, 0) / 5).toFixed(1) : '0.0'
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        
        <div className="modal-header">
          <h2>{rating.filmId?.title || 'Фильм'}</h2>
          <p>Оценка: <span style={{ color: getScoreColor(rating.finalScore), fontSize: '28px', fontWeight: 'bold' }}>{rating.finalScore}</span></p>
          <p className="modal-user">👤 {rating.userId?.nickname || 'Пользователь'}</p>
          <p>Субъективный множитель (M): <strong>{rating.subjectiveM}</strong></p>
          <p>Технический балл (T): <strong>{rating.technicalScore}</strong></p>
          {rating.textReview && (
            <div className="modal-review">
              <p><strong>Отзыв:</strong> {rating.textReview}</p>
            </div>
          )}
        </div>

        <div className="modal-bases">
          {[0, 1, 2, 3].map((baseIndex) => (
            <div key={baseIndex} className="modal-base">
              <h4>{baseNames[baseIndex]} <span className="modal-base-avg">(среднее: {baseAverages[baseIndex]})</span></h4>
              <div className="modal-criteria">
                {criteriaNames[baseIndex].map((name, critIndex) => (
                  <div key={critIndex} className="modal-criterion">
                    <span>{name}</span>
                    <span className="modal-criterion-score">{bases[baseIndex]?.[critIndex] || 0}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ===== ГЛАВНАЯ =====
function HomePage() {
  const [films, setFilms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadFilms();
  }, []);

  const loadFilms = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/films');
      setFilms(response.data.films || []);
    } catch (err) {
      console.error('Ошибка загрузки фильмов:', err);
      setError('Не удалось загрузить фильмы. Попробуйте позже.');
    } finally {
      setLoading(false);
    }
  };

  // ===== ИСПРАВЛЕННЫЙ ПОИСК =====
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try {
      // ИСПРАВЛЕНИЕ: отправляем query как params, а не в URL
      const response = await api.get('/tmdb/search', {
        params: { query: searchQuery }
      });
      setSearchResults(response.data.results || []);
      setShowSearch(true);
    } catch (err) {
      console.error('Ошибка поиска:', err);
      alert('Ошибка поиска: ' + (err.response?.data?.error || err.message));
    }
  };

  const importFilm = async (tmdbId) => {
    const token = localStorage.getItem('token');
    if (!token) {
      alert('Чтобы добавить фильм, необходимо войти в систему.');
      navigate('/login');
      return;
    }
    
    if (isImporting) return;
    setIsImporting(true);
    
    try {
      await api.post('/films/import', { tmdbId });
      alert('Фильм успешно добавлен!');
      setShowSearch(false);
      setSearchQuery('');
      await loadFilms();
    } catch (err) {
      alert('Ошибка: ' + (err.response?.data?.error || err.message));
    } finally {
      setIsImporting(false);
    }
  };

  const token = localStorage.getItem('token');

  if (loading) return <div className="loading">Загрузка...</div>;

  return (
    <div className="container">
      <header className="header">
        <h1>🎬 СИНЕФИЛИУМ</h1>
        <div className="header-actions">
          {token ? (
            <>
              <Link to="/profile" className="btn-profile">👤 Профиль</Link>
              <button
                onClick={() => {
                  localStorage.removeItem('token');
                  navigate('/');
                }}
                className="btn-logout"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#fff' }}
              >
                Выйти
              </button>
            </>
          ) : (
            <Link to="/login" className="btn-login">Войти</Link>
          )}
        </div>
      </header>

      <div className="hero">
        <h2>Храм честного кино — 20 критериев для подробной оценки</h2>
        <div className="search-box">
          <input
            type="text"
            placeholder="Найти фильм в TMDB..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button onClick={handleSearch}>🔍 Найти</button>
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {showSearch && searchResults.length > 0 && (
        <div className="search-results">
          <h3>Результаты поиска:</h3>
          <div className="films-grid">
            {searchResults.map((film) => (
              <div key={film.id} className="film-card">
                <img 
                  src={film.poster_path ? `https://image.tmdb.org/t/p/w200${film.poster_path}` : '/no-poster.jpg'} 
                  alt={film.title}
                />
                <h4>{film.title}</h4>
                <p>{film.release_date?.split('-')[0] || 'N/A'}</p>
                <button onClick={() => importFilm(film.id)} disabled={isImporting}>
                  {isImporting ? 'Добавление...' : '➕ Добавить'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {films.length === 0 ? (
        <div className="no-films">Нет добавленных фильмов. Найдите и добавьте первый!</div>
      ) : (
        <div className="films-grid">
          {films.map((film) => (
            <Link to={`/film/${film._id}`} key={film._id} className="film-card-link">
              <div className="film-card">
                <img src={film.poster || '/no-poster.jpg'} alt={film.title} />
                <div className="film-info">
                  <h3>{film.title}</h3>
                  <p>{film.year}</p>
                  <div className="rating-badge" style={{ color: getScoreColor(film.averageRating) }}>
                    {film.averageRating ? `${film.averageRating.toFixed(1)}` : 'Нет оценок'}
                  </div>
                  <span className="votes-count">👥 {film.votesCount || 0}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== СТРАНИЦА ФИЛЬМА =====
function FilmPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [film, setFilm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userRating, setUserRating] = useState(null);
  const [isRatingMode, setIsRatingMode] = useState(false);
  const [filmUsers, setFilmUsers] = useState([]);
  const [selectedRating, setSelectedRating] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);

  const [base1, setBase1] = useState([5, 5, 5, 5, 5]);
  const [base2, setBase2] = useState([5, 5, 5, 5, 5]);
  const [base3, setBase3] = useState([5, 5, 5, 5, 5]);
  const [base4, setBase4] = useState([5, 5, 5, 5, 5]);
  const [subjectiveM, setSubjectiveM] = useState(5);
  const [textReview, setTextReview] = useState('');

  useEffect(() => {
    loadFilm();
    loadFilmUsers();
  }, [id]);

  const loadFilm = async () => {
    setLoading(true);
    try {
      const response = await api.get(`/films/${id}`);
      setFilm(response.data);
      if (response.data.userRating) {
        const ur = response.data.userRating;
        setUserRating(ur);
        setBase1(ur.base1 || [5,5,5,5,5]);
        setBase2(ur.base2 || [5,5,5,5,5]);
        setBase3(ur.base3 || [5,5,5,5,5]);
        setBase4(ur.base4 || [5,5,5,5,5]);
        setSubjectiveM(ur.subjectiveM || 5);
        setTextReview(ur.textReview || '');
      } else {
        setBase1([5,5,5,5,5]);
        setBase2([5,5,5,5,5]);
        setBase3([5,5,5,5,5]);
        setBase4([5,5,5,5,5]);
        setSubjectiveM(5);
        setTextReview('');
        setUserRating(null);
      }
    } catch (err) {
      console.error('Ошибка загрузки фильма:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadFilmUsers = async () => {
    setUsersLoading(true);
    try {
      const response = await api.get(`/films/${id}/users`);
      setFilmUsers(response.data || []);
    } catch (err) {
      console.error('Ошибка загрузки пользователей:', err);
    } finally {
      setUsersLoading(false);
    }
  };

  const handleRatingChange = useCallback((baseIndex, criterionIndex, value) => {
    const setters = [setBase1, setBase2, setBase3, setBase4];
    const setter = setters[baseIndex];
    setter(prev => {
      const newArr = [...prev];
      newArr[criterionIndex] = Number(value);
      return newArr;
    });
  }, []);

  const calculatePreview = useCallback(() => {
    const avg1 = base1.reduce((a, b) => a + b, 0) / 5;
    const avg2 = base2.reduce((a, b) => a + b, 0) / 5;
    const avg3 = base3.reduce((a, b) => a + b, 0) / 5;
    const avg4 = base4.reduce((a, b) => a + b, 0) / 5;
    const T = (avg1 + avg2 + avg3 + avg4) * 1.4;
    const finalRaw = T + 34 * (subjectiveM - 1) / 9;
    return Math.min(90, Math.max(6, Math.round(finalRaw)));
  }, [base1, base2, base3, base4, subjectiveM]);

  const saveRating = async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      alert('Войдите в систему, чтобы оценивать фильмы');
      navigate('/login');
      return;
    }

    if (isSaving) return;
    setIsSaving(true);

    try {
      const response = await api.post('/ratings', {
        filmId: id,
        base1,
        base2,
        base3,
        base4,
        subjectiveM,
        textReview
      });
      
      setUserRating(response.data.rating);
      alert('Оценка сохранена!');
      await loadFilm();
      await loadFilmUsers();
    } catch (err) {
      alert('Ошибка: ' + (err.response?.data?.error || err.message));
    } finally {
      setIsSaving(false);
    }
  };

  const openRatingDetails = async (ratingData) => {
    try {
      if (ratingData.base1 && ratingData.base1.length === 5) {
        setSelectedRating(ratingData);
        return;
      }
      const response = await api.get(`/ratings/${ratingData.id}/details`);
      setSelectedRating(response.data);
    } catch (err) {
      console.error('Ошибка загрузки деталей оценки:', err);
      alert('Не удалось загрузить детали оценки.');
    }
  };

  const toggleRatingMode = () => {
    setIsRatingMode(!isRatingMode);
  };

  if (loading) return <div className="loading">Загрузка...</div>;
  if (!film) return <div className="error">Фильм не найден</div>;

  const previewScore = calculatePreview();

  return (
    <div className="container">
      <div className="film-page">
        <button onClick={() => navigate('/')} className="back-btn">← На главную</button>
        
        <div className="film-header">
          <img src={film.poster || '/no-poster.jpg'} alt={film.title} className="film-poster-large" />
          <div className="film-details">
            <h1>{film.title}</h1>
            <p className="film-year">{film.year}</p>
            <p className="film-description">{film.description}</p>
            <p><strong>Режиссёр:</strong> {film.director}</p>
            <p><strong>Актёры:</strong> {film.actors?.join(', ') || 'Нет данных'}</p>
            <div className="film-genres">
              {film.genres?.map((g, i) => <span key={i} className="genre-tag">{g}</span>)}
            </div>
            
            <div className="film-rating-stats">
              <div className="avg-rating" style={{ color: getScoreColor(film.averageRating) }}>
                {film.averageRating ? `${film.averageRating.toFixed(1)}` : 'Нет оценок'}
              </div>
              <span>👥 {film.votesCount || 0} оценок</span>
            </div>

            {userRating && (
              <div className="your-rating">
                <h4>Ваша оценка:</h4>
                <div className="user-rating-display" style={{ color: getScoreColor(userRating.finalScore) }}>
                  {userRating.finalScore}
                </div>
              </div>
            )}

            <button className="rate-btn" onClick={toggleRatingMode}>
              {isRatingMode ? 'Скрыть форму' : (userRating ? '✏️ Изменить оценку' : '⭐ Оценить фильм')}
            </button>
          </div>
        </div>

        {usersLoading ? (
          <div className="loading">Загрузка пользователей...</div>
        ) : filmUsers.length > 0 ? (
          <div className="film-users">
            <h3>Оценили фильм: {filmUsers.length} человек</h3>
            <div className="users-list">
              {filmUsers.map((item) => (
                <div key={`${item.user.id}-${item.rating.id}`} className="user-rating-item">
                  <Link to={`/user/${item.user.id}`} className="user-link">
                    👤 {item.user.nickname}
                  </Link>
                  <span className="user-rating-score" style={{ color: getScoreColor(item.rating.finalScore) }}>
                    {item.rating.finalScore}
                  </span>
                  <button 
                    className="details-btn"
                    onClick={() => openRatingDetails(item.rating)}
                  >
                    🔍 Детали
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {isRatingMode && (
          <div className="rating-form">
            <h2>Оценка по 20 критериям</h2>
            <p className="rating-hint">Оценка от 1 до 10 (1 — ужасно, 10 — идеально)</p>
            
            {[0, 1, 2, 3].map((baseIndex) => (
              <div key={baseIndex} className="rating-base">
                <h3>{baseNames[baseIndex]}</h3>
                {criteriaNames[baseIndex].map((name, critIndex) => {
                  const values = [base1, base2, base3, base4];
                  const value = values[baseIndex][critIndex];
                  return (
                    <div key={critIndex} className="criterion">
                      <label>
                        {name}
                        <span className="criterion-hint" title={baseDescriptions[baseIndex][critIndex]}>❓</span>
                      </label>
                      <div className="slider-container">
                        <span>1</span>
                        <input
                          type="range"
                          min="1"
                          max="10"
                          step="1"
                          value={value}
                          onChange={(e) => handleRatingChange(baseIndex, critIndex, e.target.value)}
                        />
                        <span>10</span>
                        <span className="value-display">{value}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            <div className="subjective-block">
              <h3>Субъективный множитель (M)</h3>
              <p>Насколько лично вам понравился фильм, несмотря на технические оценки?</p>
              <div className="slider-container">
                <span>1</span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  value={subjectiveM}
                  onChange={(e) => setSubjectiveM(Number(e.target.value))}
                />
                <span>10</span>
                <span className="value-display">{subjectiveM}</span>
              </div>
            </div>

            <div className="text-review">
              <h3>Текстовый отзыв (необязательно)</h3>
              <textarea
                value={textReview}
                onChange={(e) => setTextReview(e.target.value.slice(0, 1000))}
                placeholder="Напишите свои впечатления..."
                rows="4"
                maxLength={1000}
              />
              <div className="char-counter">{textReview.length}/1000</div>
            </div>

            <div className="rating-preview">
              <h3>Итоговая оценка:</h3>
              <div className="preview-score" style={{ color: getScoreColor(previewScore) }}>
                {previewScore}
              </div>
              <div className="score-bar" style={{ 
                width: `${(previewScore - 6) / 84 * 100}%`,
                background: `linear-gradient(to right, #ff1744, #ffab00, #00e676)`
              }}></div>
              <div className="score-labels">
                <span>6 (провал)</span>
                <span>90 (шедевр)</span>
              </div>
              <button onClick={saveRating} className="save-rating-btn" disabled={isSaving}>
                {isSaving ? 'Сохранение...' : '💾 Сохранить оценку'}
              </button>
            </div>
          </div>
        )}

        {film.trailer && (
          <div className="trailer">
            <h3>Трейлер</h3>
            <iframe src={film.trailer} title="Трейлер" allowFullScreen />
          </div>
        )}
      </div>

      <RatingDetailsModal 
        rating={selectedRating} 
        onClose={() => setSelectedRating(null)} 
      />
    </div>
  );
}

// ===== ВХОД / РЕГИСТРАЦИЯ =====
function LoginPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = isLogin ? '/auth/login' : '/auth/register';
      const data = isLogin ? { email, password } : { email, password, nickname };
      
      const response = await api.post(endpoint, data);
      localStorage.setItem('token', response.data.token);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Произошла ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container auth-container">
      <div className="auth-box">
        <h1>{isLogin ? 'Вход в Синефилиум' : 'Регистрация'}</h1>
        {error && <div className="error-msg">{error}</div>}
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {!isLogin && (
            <input
              type="text"
              placeholder="Никнейм"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              required
            />
          )}
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Загрузка...' : (isLogin ? 'Войти' : 'Зарегистрироваться')}
          </button>
        </form>
        <p onClick={() => { setIsLogin(!isLogin); setError(''); }} className="toggle-auth">
          {isLogin ? 'Нет аккаунта? Зарегистрируйтесь' : 'Уже есть аккаунт? Войдите'}
        </p>
      </div>
    </div>
  );
}

// ===== ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ =====
function ProfilePage() {
  const [user, setUser] = useState(null);
  const [ratings, setRatings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedRating, setSelectedRating] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      const userResponse = await api.get('/auth/me');
      setUser(userResponse.data);

      const ratingsResponse = await api.get('/ratings/user');
      setRatings(ratingsResponse.data || []);
    } catch (err) {
      console.error('Ошибка загрузки профиля:', err);
      if (err.response?.status === 401) {
        localStorage.removeItem('token');
        navigate('/login');
      }
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    navigate('/');
  };

  const openRatingDetails = async (rating) => {
    try {
      const response = await api.get(`/ratings/${rating._id}/details`);
      setSelectedRating(response.data);
    } catch (err) {
      console.error('Ошибка загрузки деталей оценки:', err);
      alert('Не удалось загрузить детали оценки.');
    }
  };

  if (loading) return <div className="loading">Загрузка...</div>;
  if (!user) return <div className="error">Не удалось загрузить профиль</div>;

  return (
    <div className="container profile-page">
      <button onClick={() => navigate('/')} className="back-btn">← На главную</button>
      
      <div className="profile-header">
        <div className="profile-avatar">
          <div className="avatar-placeholder">{user.nickname[0]}</div>
        </div>
        <div className="profile-info">
          <h1>{user.nickname}</h1>
          <p>📧 {user.email}</p>
          <p>⭐ Всего оценок: {ratings.length}</p>
          <button onClick={logout} className="logout-btn">🚪 Выйти</button>
        </div>
      </div>

      <div className="profile-ratings">
        <h2>Мои оценки</h2>
        {ratings.length === 0 ? (
          <p>Вы еще не оценили ни одного фильма</p>
        ) : (
          <div className="ratings-list">
            {ratings.map((rating) => (
              <div key={rating._id} className="rating-item">
                <Link to={`/film/${rating.filmId._id}`}>
                  <div className="rating-film-info">
                    <img src={rating.filmId.poster || '/no-poster.jpg'} alt={rating.filmId.title} className="rating-poster-small" />
                    <div>
                      <h4>{rating.filmId.title}</h4>
                      <p>{rating.filmId.year}</p>
                    </div>
                  </div>
                </Link>
                <div className="rating-score" style={{ color: getScoreColor(rating.finalScore) }}>
                  {rating.finalScore}
                </div>
                <button 
                  className="details-btn"
                  onClick={() => openRatingDetails(rating)}
                >
                  🔍 Детали
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <RatingDetailsModal 
        rating={selectedRating} 
        onClose={() => setSelectedRating(null)} 
      />
    </div>
  );
}

// ===== ПРОФИЛЬ ДРУГОГО ПОЛЬЗОВАТЕЛЯ =====
function UserProfilePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [ratings, setRatings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedRating, setSelectedRating] = useState(null);

  useEffect(() => {
    loadUserProfile();
  }, [id]);

  const loadUserProfile = async () => {
    try {
      const response = await api.get(`/users/${id}`);
      setUser(response.data.user);
      setRatings(response.data.ratings || []);
    } catch (err) {
      console.error('Ошибка загрузки профиля:', err);
    } finally {
      setLoading(false);
    }
  };

  const openRatingDetails = async (rating) => {
    try {
      const response = await api.get(`/ratings/${rating.id}/details`);
      setSelectedRating(response.data);
    } catch (err) {
      console.error('Ошибка загрузки деталей оценки:', err);
      alert('Не удалось загрузить детали оценки.');
    }
  };

  if (loading) return <div className="loading">Загрузка...</div>;
  if (!user) return <div className="error">Пользователь не найден</div>;

  return (
    <div className="container profile-page">
      <button onClick={() => navigate('/')} className="back-btn">← На главную</button>
      
      <div className="profile-header">
        <div className="profile-avatar">
          <div className="avatar-placeholder">{user.nickname[0]}</div>
        </div>
        <div className="profile-info">
          <h1>{user.nickname}</h1>
          <p>📅 Зарегистрирован: {new Date(user.registeredAt).toLocaleDateString()}</p>
          <p>⭐ Всего оценок: {ratings.length}</p>
        </div>
      </div>

      <div className="profile-ratings">
        <h2>Оценки пользователя</h2>
        {ratings.length === 0 ? (
          <p>Пользователь еще не оценил ни одного фильма</p>
        ) : (
          <div className="ratings-list">
            {ratings.map((rating) => (
              <div key={rating.id} className="rating-item">
                <Link to={`/film/${rating.film._id}`}>
                  <div className="rating-film-info">
                    <img src={rating.film.poster || '/no-poster.jpg'} alt={rating.film.title} className="rating-poster-small" />
                    <div>
                      <h4>{rating.film.title}</h4>
                      <p>{rating.film.year}</p>
                    </div>
                  </div>
                </Link>
                <div className="rating-score" style={{ color: getScoreColor(rating.finalScore) }}>
                  {rating.finalScore}
                </div>
                <button 
                  className="details-btn"
                  onClick={() => openRatingDetails(rating)}
                >
                  🔍 Детали
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <RatingDetailsModal 
        rating={selectedRating} 
        onClose={() => setSelectedRating(null)} 
      />
    </div>
  );
}

// ===== ГЛАВНОЕ ПРИЛОЖЕНИЕ =====
function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/film/:id" element={<FilmPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/user/:id" element={<UserProfilePage />} />
      </Routes>
    </Router>
  );
}

export default App;
